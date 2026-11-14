#include "pch.h"

#include "FlickServerModule.h"

#include "server/FlickServerCore.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <KnownFolders.h>

#include <winrt/Windows.Graphics.h>

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <memory>
#include <mutex>
#include <vector>

#pragma comment(lib, "Iphlpapi.lib")
#pragma comment(lib, "Ws2_32.lib")
#pragma comment(lib, "Shell32.lib")
#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "uuid.lib")

using namespace winrt::Microsoft::ReactNative;
namespace Windowing = winrt::Microsoft::UI::Windowing;

namespace FlickSendDesktop {

namespace {

// ---- process-wide state ---------------------------------------------------
// The server outlives module instances (a JS reload creates a new module), so
// the paired phone keeps working and the port never changes under it.

using EmitFn = std::function<void(std::string)>;

struct Emitters {
  std::mutex mutex;
  EmitFn incoming, progress, complete, error;
};

Emitters &GetEmitters() {
  static Emitters e;
  return e;
}

void Emit(EmitFn Emitters::*which, std::string payload) {
  EmitFn fn;
  {
    auto &e = GetEmitters();
    std::lock_guard<std::mutex> lock(e.mutex);
    fn = e.*which;
  }
  if (fn)
    fn(std::move(payload));
}

std::mutex g_serverMutex;
flicksend::Server *g_server = nullptr; // intentionally never freed
std::atomic<uint16_t> g_port{0};
std::filesystem::path g_saveDir;

std::string Utf8(std::wstring const &w) {
  return winrt::to_string(w);
}

std::wstring Wide(std::string const &s) {
  return std::wstring(winrt::to_hstring(s));
}

std::filesystem::path KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR raw = nullptr;
  std::filesystem::path result;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &raw)) && raw)
    result = raw;
  CoTaskMemFree(raw);
  return result;
}

std::string ComputerName() {
  wchar_t buf[256];
  DWORD len = ARRAYSIZE(buf);
  if (GetComputerNameExW(ComputerNamePhysicalDnsHostname, buf, &len) && len > 0)
    return Utf8(std::wstring(buf, len));
  return "Laptop";
}

// LAN IPv4 addresses, most likely-to-work first (real adapters with a gateway).
std::vector<std::string> LanAddresses() {
  ULONG size = 16 * 1024;
  std::vector<unsigned char> buf(size);
  const ULONG flags =
      GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_INCLUDE_GATEWAYS;
  ULONG r = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buf.data()), &size);
  if (r == ERROR_BUFFER_OVERFLOW) {
    buf.resize(size);
    r = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buf.data()), &size);
  }
  if (r != NO_ERROR)
    return {};

  struct Candidate {
    std::string ip;
    int score;
  };
  std::vector<Candidate> candidates;
  for (auto *a = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buf.data()); a; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK)
      continue;
    int score = 0;
    if (a->FirstGatewayAddress)
      score += 10;
    if (a->IfType == IF_TYPE_IEEE80211)
      score += 3;
    else if (a->IfType == IF_TYPE_ETHERNET_CSMACD)
      score += 2;
    std::wstring desc = a->Description ? a->Description : L"";
    for (auto const *bad : {L"Virtual", L"Hyper-V", L"VMware", L"VirtualBox", L"WSL", L"Loopback", L"TAP"}) {
      if (desc.find(bad) != std::wstring::npos)
        score -= 8;
    }
    for (auto *u = a->FirstUnicastAddress; u; u = u->Next) {
      if (!u->Address.lpSockaddr || u->Address.lpSockaddr->sa_family != AF_INET)
        continue;
      auto *sin = reinterpret_cast<sockaddr_in *>(u->Address.lpSockaddr);
      char ip[INET_ADDRSTRLEN] = {};
      if (!inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip)))
        continue;
      std::string s(ip);
      if (s.rfind("169.254.", 0) == 0 || s.rfind("127.", 0) == 0)
        continue;
      candidates.push_back({s, score});
    }
  }
  std::stable_sort(candidates.begin(), candidates.end(), [](auto const &x, auto const &y) { return x.score > y.score; });
  std::vector<std::string> out;
  for (auto const &c : candidates) {
    if (out.size() < 6 && std::find(out.begin(), out.end(), c.ip) == out.end())
      out.push_back(c.ip);
  }
  return out;
}

bool InsideSaveDir(std::filesystem::path const &p) {
  std::error_code ec1, ec2;
  auto file = std::filesystem::weakly_canonical(p, ec1);
  auto base = std::filesystem::weakly_canonical(g_saveDir, ec2);
  if (ec1 || ec2 || base.empty())
    return false;
  auto rel = file.lexically_relative(base);
  return !rel.empty() && *rel.begin() != L"..";
}

// ---- window helpers (UI thread only) ----------------------------------------

HWND FindMainWindow() {
  static HWND cached = nullptr;
  if (cached && IsWindow(cached))
    return cached;
  struct Ctx {
    DWORD pid;
    HWND best;
    long long bestArea;
  } ctx{GetCurrentProcessId(), nullptr, -1};
  EnumWindows(
      [](HWND h, LPARAM lp) -> BOOL {
        auto *c = reinterpret_cast<Ctx *>(lp);
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        if (pid != c->pid || !IsWindowVisible(h) || GetWindow(h, GW_OWNER))
          return TRUE;
        RECT r{};
        GetWindowRect(h, &r);
        long long area = static_cast<long long>(r.right - r.left) * (r.bottom - r.top);
        if (area > c->bestArea) {
          c->bestArea = area;
          c->best = h;
        }
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&ctx));
  cached = ctx.best;
  return cached;
}

void ForceForeground(HWND hwnd) {
  HWND fg = GetForegroundWindow();
  DWORD fgThread = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
  DWORD me = GetCurrentThreadId();
  bool attached = fgThread && fgThread != me && AttachThreadInput(me, fgThread, TRUE);
  SetForegroundWindow(hwnd);
  BringWindowToTop(hwnd);
  if (attached)
    AttachThreadInput(me, fgThread, FALSE);
}

struct OverlayState {
  bool active = false;
  bool wasMinimized = false;
  bool wasMaximized = false;
  winrt::Windows::Graphics::RectInt32 bounds{};
} g_overlay;

void ApplyOverlay(bool on) {
  HWND hwnd = FindMainWindow();
  if (!hwnd)
    return;
  Windowing::AppWindow appWindow{nullptr};
  try {
    appWindow = Windowing::AppWindow::GetFromWindowId(winrt::Microsoft::UI::GetWindowIdFromWindow(hwnd));
  } catch (...) {
  }

  if (on) {
    if (!g_overlay.active) {
      g_overlay.active = true;
      g_overlay.wasMinimized = IsIconic(hwnd) != FALSE;
      g_overlay.wasMaximized = IsZoomed(hwnd) != FALSE;
      if (g_overlay.wasMinimized || g_overlay.wasMaximized)
        ShowWindow(hwnd, SW_RESTORE);
      if (appWindow) {
        auto pos = appWindow.Position();
        auto size = appWindow.Size();
        g_overlay.bounds = {pos.X, pos.Y, size.Width, size.Height};
      }
    }
    // "Main desktop screen" = the primary monitor.
    MONITORINFO mi{sizeof(mi)};
    GetMonitorInfoW(MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY), &mi);
    if (appWindow) {
      if (appWindow.Presenter().Kind() != Windowing::AppWindowPresenterKind::FullScreen) {
        appWindow.Move({mi.rcMonitor.left + 40, mi.rcMonitor.top + 40});
        appWindow.SetPresenter(Windowing::AppWindowPresenterKind::FullScreen);
      }
    } else {
      SetWindowPos(
          hwnd,
          nullptr,
          mi.rcMonitor.left,
          mi.rcMonitor.top,
          mi.rcMonitor.right - mi.rcMonitor.left,
          mi.rcMonitor.bottom - mi.rcMonitor.top,
          SWP_NOZORDER);
    }
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    ForceForeground(hwnd);
  } else {
    if (!g_overlay.active)
      return;
    g_overlay.active = false;
    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    if (appWindow) {
      appWindow.SetPresenter(Windowing::AppWindowPresenterKind::Overlapped);
      if (g_overlay.bounds.Width > 0 && g_overlay.bounds.Height > 0)
        appWindow.MoveAndResize(g_overlay.bounds);
    }
    if (g_overlay.wasMaximized)
      ShowWindow(hwnd, SW_MAXIMIZE);
    if (g_overlay.wasMinimized)
      ShowWindow(hwnd, SW_MINIMIZE);
  }
}

} // namespace

// ---------------------------------------------------------------------------

void FlickServer::Initialize(ReactContext const &reactContext) noexcept {
  m_context = reactContext;
}

void FlickServer::Start(ReactPromise<std::string> promise) noexcept {
  try {
    {
      auto &e = GetEmitters();
      std::lock_guard<std::mutex> lock(e.mutex);
      e.incoming = OnIncoming;
      e.progress = OnProgress;
      e.complete = OnComplete;
      e.error = OnError;
    }

    std::lock_guard<std::mutex> lock(g_serverMutex);
    if (!g_server) {
      flicksend::ServerConfig config;
      config.token = flicksend::LoadOrCreateToken(KnownFolder(FOLDERID_LocalAppData) / L"FlickSend" / L"token.txt");
      config.saveDir = KnownFolder(FOLDERID_Pictures) / L"FlickSend";
      config.deviceName = ComputerName();
      config.preferredPort = 47821;

      flicksend::ServerEvents events;
      events.onIncoming = [](std::string const &json) { Emit(&Emitters::incoming, json); };
      events.onProgress = [](std::string const &id, uint64_t received, uint64_t total) {
        Emit(
            &Emitters::progress,
            "{\"id\":\"" + flicksend::JsonEscape(id) + "\",\"received\":" + std::to_string(received) +
                ",\"total\":" + std::to_string(total) + "}");
      };
      events.onComplete = [](std::string const &id, std::filesystem::path const &file) {
        std::string url = "http://127.0.0.1:" + std::to_string(g_port.load()) + "/media/" + id;
        Emit(
            &Emitters::complete,
            "{\"id\":\"" + flicksend::JsonEscape(id) + "\",\"path\":\"" + flicksend::JsonEscape(Utf8(file.wstring())) +
                "\",\"url\":\"" + url + "\"}");
      };
      events.onError = [](std::string const &id, std::string const &error) {
        Emit(
            &Emitters::error,
            "{\"id\":\"" + flicksend::JsonEscape(id) + "\",\"error\":\"" + flicksend::JsonEscape(error) + "\"}");
      };

      auto server = std::make_unique<flicksend::Server>(config, events);
      std::string err;
      if (!server->Start(err)) {
        promise.Reject(err.c_str());
        return;
      }
      g_port = server->Port();
      g_saveDir = config.saveDir;
      g_server = server.release();
    }

    auto const &config = g_server->Config();
    std::string hosts;
    for (auto const &h : LanAddresses()) {
      hosts += (hosts.empty() ? "\"" : ",\"") + h + "\"";
    }
    promise.Resolve(
        "{\"port\":" + std::to_string(g_port.load()) + ",\"token\":\"" + flicksend::JsonEscape(config.token) +
        "\",\"name\":\"" + flicksend::JsonEscape(config.deviceName) + "\",\"hosts\":[" + hosts + "],\"saveDir\":\"" +
        flicksend::JsonEscape(Utf8(config.saveDir.wstring())) + "\"}");
  } catch (std::exception const &ex) {
    promise.Reject(ex.what());
  } catch (...) {
    promise.Reject("FlickServer failed to start");
  }
}

void FlickServer::SetOverlay(bool on) noexcept {
  m_context.UIDispatcher().Post([on]() { ApplyOverlay(on); });
}

void FlickServer::OpenFile(std::string path) noexcept {
  std::wstring wide = Wide(path);
  if (!InsideSaveDir(wide))
    return;
  m_context.UIDispatcher().Post(
      [wide]() {
        // Leave the always-on-top stage so the player is visible.
        ApplyOverlay(false);
        ShellExecuteW(nullptr, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
      });
}

void FlickServer::RevealFile(std::string path) noexcept {
  std::wstring wide = Wide(path);
  if (!InsideSaveDir(wide))
    return;
  m_context.UIDispatcher().Post([wide]() {
    // Leave the always-on-top stage so Explorer is visible.
    ApplyOverlay(false);
    PIDLIST_ABSOLUTE pidl = ILCreateFromPathW(wide.c_str());
    if (pidl) {
      SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
      ILFree(pidl);
    }
  });
}

} // namespace FlickSendDesktop
