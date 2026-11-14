// See FlickServerCore.h. Compiled without the precompiled header so it stays portable.
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "Ws2_32.lib")
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include "FlickServerCore.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fstream>
#include <random>
#include <sstream>
#include <system_error>
#include <vector>

namespace flicksend {

namespace {

#ifdef _WIN32
using NativeSocket = SOCKET;
constexpr NativeSocket kInvalid = INVALID_SOCKET;
void CloseNative(NativeSocket s) {
  closesocket(s);
}
#else
using NativeSocket = int;
constexpr NativeSocket kInvalid = -1;
void CloseNative(NativeSocket s) {
  ::close(s);
}
#endif

#ifdef MSG_NOSIGNAL
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;
#endif

constexpr size_t kMaxHeaderBytes = 16 * 1024;
constexpr size_t kIoChunk = 64 * 1024;
constexpr int kSocketTimeoutMs = 30000;

bool IsAsciiAlnum(unsigned char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

std::string ToLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string Trim(const std::string &s) {
  size_t b = 0, e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n'))
    ++b;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n'))
    --e;
  return s.substr(b, e - b);
}

bool ParseUint64(const std::string &s, uint64_t &out) {
  if (s.empty() || s.size() > 19)
    return false;
  uint64_t v = 0;
  for (char c : s) {
    if (c < '0' || c > '9')
      return false;
    v = v * 10 + static_cast<uint64_t>(c - '0');
  }
  out = v;
  return true;
}

// Buffered socket connection. Owns the socket.
class Conn {
 public:
  explicit Conn(NativeSocket s) : m_s(s) {}
  ~Conn() {
    CloseNative(m_s);
  }
  Conn(const Conn &) = delete;
  Conn &operator=(const Conn &) = delete;

  // >0 bytes read, 0 EOF, <0 error/timeout.
  long long RecvSome(char *buf, size_t n) {
    if (m_pos < m_pending.size()) {
      size_t take = std::min(n, m_pending.size() - m_pos);
      std::memcpy(buf, m_pending.data() + m_pos, take);
      m_pos += take;
      if (m_pos == m_pending.size()) {
        m_pending.clear();
        m_pos = 0;
      }
      return static_cast<long long>(take);
    }
    int want = static_cast<int>(std::min<size_t>(n, kIoChunk));
    return static_cast<long long>(::recv(m_s, buf, want, 0));
  }

  bool ReadExact(char *buf, size_t n) {
    while (n > 0) {
      long long r = RecvSome(buf, n);
      if (r <= 0)
        return false;
      buf += r;
      n -= static_cast<size_t>(r);
    }
    return true;
  }

  // Reads a CRLF-terminated line (without the CRLF).
  bool ReadLine(std::string &line, size_t maxLen) {
    line.clear();
    char c;
    while (line.size() <= maxLen) {
      if (RecvSome(&c, 1) != 1)
        return false;
      if (c == '\n') {
        if (!line.empty() && line.back() == '\r')
          line.pop_back();
        return true;
      }
      line.push_back(c);
    }
    return false;
  }

  // Reads until the end of HTTP headers. Leftover bytes stay buffered for the body.
  bool ReadHeaderBlock(std::string &head) {
    std::string buf;
    char tmp[4096];
    for (;;) {
      size_t end = buf.find("\r\n\r\n");
      if (end != std::string::npos) {
        head = buf.substr(0, end);
        m_pending = buf.substr(end + 4);
        m_pos = 0;
        return true;
      }
      if (buf.size() > kMaxHeaderBytes)
        return false;
      auto r = static_cast<long long>(::recv(m_s, tmp, static_cast<int>(sizeof(tmp)), 0));
      if (r <= 0)
        return false;
      buf.append(tmp, static_cast<size_t>(r));
    }
  }

  bool SendAll(const char *data, size_t n) {
    while (n > 0) {
      int chunk = static_cast<int>(std::min<size_t>(n, kIoChunk));
      auto r = static_cast<long long>(::send(m_s, data, chunk, kSendFlags));
      if (r <= 0)
        return false;
      data += r;
      n -= static_cast<size_t>(r);
    }
    return true;
  }

  bool SendAll(const std::string &s) {
    return SendAll(s.data(), s.size());
  }

 private:
  NativeSocket m_s;
  std::string m_pending;
  size_t m_pos = 0;
};

// Reads an HTTP request body with either Content-Length or chunked encoding.
class BodyReader {
 public:
  BodyReader(Conn &c, bool chunked, uint64_t length) : m_c(c), m_chunked(chunked), m_remaining(length) {}

  // >0 bytes, 0 end of body, <0 error.
  long long Read(char *buf, size_t n) {
    if (m_done)
      return 0;
    if (!m_chunked) {
      if (m_remaining == 0) {
        m_done = true;
        return 0;
      }
      size_t want = static_cast<size_t>(std::min<uint64_t>(n, m_remaining));
      long long r = m_c.RecvSome(buf, want);
      if (r <= 0)
        return -1;
      m_remaining -= static_cast<uint64_t>(r);
      return r;
    }
    if (m_remaining == 0) {
      if (m_sawChunk) {
        std::string crlf;
        if (!m_c.ReadLine(crlf, 2) || !crlf.empty())
          return -1;
      }
      std::string sizeLine;
      if (!m_c.ReadLine(sizeLine, 128))
        return -1;
      size_t semi = sizeLine.find(';');
      if (semi != std::string::npos)
        sizeLine = sizeLine.substr(0, semi);
      sizeLine = Trim(sizeLine);
      if (sizeLine.empty() || sizeLine.size() > 15)
        return -1;
      uint64_t size = 0;
      for (char ch : sizeLine) {
        int d;
        if (ch >= '0' && ch <= '9')
          d = ch - '0';
        else if (ch >= 'a' && ch <= 'f')
          d = ch - 'a' + 10;
        else if (ch >= 'A' && ch <= 'F')
          d = ch - 'A' + 10;
        else
          return -1;
        size = size * 16 + static_cast<uint64_t>(d);
      }
      m_sawChunk = true;
      if (size == 0) {
        // Skip trailers until the empty line.
        std::string trailer;
        do {
          if (!m_c.ReadLine(trailer, 8192))
            return -1;
        } while (!trailer.empty());
        m_done = true;
        return 0;
      }
      m_remaining = size;
    }
    size_t want = static_cast<size_t>(std::min<uint64_t>(n, m_remaining));
    long long r = m_c.RecvSome(buf, want);
    if (r <= 0)
      return -1;
    m_remaining -= static_cast<uint64_t>(r);
    return r;
  }

 private:
  Conn &m_c;
  bool m_chunked;
  uint64_t m_remaining;
  bool m_sawChunk = false;
  bool m_done = false;
};

struct Request {
  std::string method;
  std::string path;
  std::map<std::string, std::string> headers; // lower-cased names

  std::string Header(const std::string &name) const {
    auto it = headers.find(name);
    return it == headers.end() ? std::string() : it->second;
  }
};

bool ParseRequest(const std::string &head, Request &req) {
  std::istringstream in(head);
  std::string line;
  if (!std::getline(in, line))
    return false;
  line = Trim(line);
  size_t sp1 = line.find(' ');
  size_t sp2 = line.rfind(' ');
  if (sp1 == std::string::npos || sp2 == sp1)
    return false;
  req.method = line.substr(0, sp1);
  std::string target = line.substr(sp1 + 1, sp2 - sp1 - 1);
  size_t q = target.find('?');
  req.path = q == std::string::npos ? target : target.substr(0, q);
  if (req.path.empty() || req.path[0] != '/')
    return false;
  while (std::getline(in, line)) {
    line = Trim(line);
    if (line.empty())
      continue;
    size_t colon = line.find(':');
    if (colon == std::string::npos)
      return false;
    req.headers[ToLower(Trim(line.substr(0, colon)))] = Trim(line.substr(colon + 1));
  }
  return true;
}

const char *ReasonFor(int status) {
  switch (status) {
    case 200:
      return "OK";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 411:
      return "Length Required";
    case 413:
      return "Payload Too Large";
    case 431:
      return "Request Header Fields Too Large";
    default:
      return "Internal Server Error";
  }
}

void SendResponse(Conn &c, int status, const std::string &body, const std::string &contentType = "application/json") {
  std::string out = "HTTP/1.1 " + std::to_string(status) + " " + ReasonFor(status) + "\r\n";
  out += "Content-Type: " + contentType + "\r\n";
  out += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  out += "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
  out += body;
  c.SendAll(out);
}

void SendError(Conn &c, int status, const std::string &message) {
  SendResponse(c, status, "{\"ok\":false,\"error\":\"" + JsonEscape(message) + "\"}");
}

std::string Timestamp() {
  std::time_t now = std::time(nullptr);
  std::tm tmv{};
#ifdef _WIN32
  localtime_s(&tmv, &now);
#else
  localtime_r(&now, &tmv);
#endif
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y%m%d-%H%M%S", &tmv);
  return buf;
}

std::filesystem::path UniquePath(const std::filesystem::path &dir, const std::string &fileName) {
  std::filesystem::path candidate = dir / fileName;
  std::error_code ec;
  if (!std::filesystem::exists(candidate, ec))
    return candidate;
  std::string stem = std::filesystem::path(fileName).stem().string();
  std::string ext = std::filesystem::path(fileName).extension().string();
  for (int i = 1; i < 10000; ++i) {
    candidate = dir / (stem + "-" + std::to_string(i) + ext);
    if (!std::filesystem::exists(candidate, ec))
      return candidate;
  }
  return dir / (stem + "-" + GenerateToken().substr(0, 8) + ext);
}

} // namespace

// ---------------------------------------------------------------------------
// Helpers

std::string GenerateToken() {
  std::random_device rd;
  std::uniform_int_distribution<int> dist(0, 255);
  static const char *hex = "0123456789abcdef";
  std::string out;
  for (int i = 0; i < 16; ++i) {
    int b = dist(rd);
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 15]);
  }
  return out;
}

std::string LoadOrCreateToken(const std::filesystem::path &file) {
  {
    std::ifstream in(file);
    std::string line;
    if (in && std::getline(in, line)) {
      line = Trim(line);
      if (line.size() >= 16 && line.size() <= 128)
        return line;
    }
  }
  std::string token = GenerateToken();
  std::error_code ec;
  std::filesystem::create_directories(file.parent_path(), ec);
  std::ofstream out(file, std::ios::trunc);
  out << token << "\n";
  return token;
}

std::string JsonEscape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

std::string UrlDecode(const std::string &s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) &&
        std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
      out.push_back(static_cast<char>(std::stoi(s.substr(i + 1, 2), nullptr, 16)));
      i += 2;
    } else if (c == '+') {
      out.push_back(' ');
    } else {
      out.push_back(c);
    }
  }
  return out;
}

std::string ExtensionForMime(const std::string &mimeIn) {
  std::string mime = ToLower(mimeIn);
  size_t semi = mime.find(';');
  if (semi != std::string::npos)
    mime = Trim(mime.substr(0, semi));
  static const std::map<std::string, std::string> table = {
      {"image/jpeg", ".jpg"},  {"image/jpg", ".jpg"},        {"image/png", ".png"},     {"image/gif", ".gif"},
      {"image/webp", ".webp"}, {"image/heic", ".heic"},      {"image/heif", ".heif"},   {"image/bmp", ".bmp"},
      {"video/mp4", ".mp4"},   {"video/quicktime", ".mov"},  {"video/webm", ".webm"},   {"video/3gpp", ".3gp"},
      {"video/x-matroska", ".mkv"}, {"video/x-msvideo", ".avi"},
  };
  auto it = table.find(mime);
  if (it != table.end())
    return it->second;
  if (mime.rfind("video/", 0) == 0)
    return ".mp4";
  if (mime.rfind("image/", 0) == 0)
    return ".jpg";
  return ".bin";
}

std::string SanitizeFileName(const std::string &name, const std::string &mime) {
  // Keep only the last path component.
  std::string base = name;
  size_t slash = base.find_last_of("/\\");
  if (slash != std::string::npos)
    base = base.substr(slash + 1);

  auto keep = [](const std::string &in, bool allowDot) {
    std::string out;
    for (unsigned char c : in) {
      if (IsAsciiAlnum(c) || c == '-' || c == '_' || (allowDot && c == '.'))
        out.push_back(static_cast<char>(c));
      else if (c == ' ')
        out.push_back('_');
    }
    return out;
  };

  std::string stem = base;
  std::string ext;
  size_t dot = base.rfind('.');
  if (dot != std::string::npos) {
    std::string candidate = keep(base.substr(dot + 1), false);
    if (!candidate.empty() && candidate.size() <= 5 && candidate.size() == base.size() - dot - 1) {
      ext = "." + ToLower(candidate);
      stem = base.substr(0, dot);
    }
  }
  if (ext.empty())
    ext = ExtensionForMime(mime);

  stem = keep(stem, true);
  while (!stem.empty() && stem.front() == '.')
    stem.erase(stem.begin());
  while (!stem.empty() && (stem.back() == '.' || stem.back() == '_'))
    stem.pop_back();
  if (stem.empty())
    stem = "flick";
  if (stem.size() > 80)
    stem = stem.substr(0, 80);
  return stem + ext;
}

bool IsValidId(const std::string &id) {
  if (id.size() < 8 || id.size() > 64)
    return false;
  for (unsigned char c : id) {
    if (!(IsAsciiAlnum(c) || c == '-' || c == '_'))
      return false;
  }
  return true;
}

bool ConstantTimeEquals(const std::string &a, const std::string &b) {
  unsigned char diff = static_cast<unsigned char>(a.size() != b.size());
  size_t n = std::max(a.size(), b.size());
  for (size_t i = 0; i < n; ++i) {
    unsigned char x = i < a.size() ? static_cast<unsigned char>(a[i]) : 0;
    unsigned char y = i < b.size() ? static_cast<unsigned char>(b[i]) : 0;
    diff |= static_cast<unsigned char>(x ^ y);
  }
  return diff == 0;
}

// ---------------------------------------------------------------------------
// Server

struct Server::Shared {
  ServerConfig config;
  ServerEvents events;
  std::atomic<bool> running{false};
  std::atomic<uint16_t> port{0};
  NativeSocket listenSocket = kInvalid;
  std::mutex mediaMutex;
  std::map<std::string, MediaEntry> media;

  void HandleConnection(NativeSocket s, bool loopback);
  void HandleHello(Conn &c);
  void HandleFlick(Conn &c, const Request &req, BodyReader &body, uint64_t length);
  void HandleUpload(Conn &c, const Request &req, const std::string &id, BodyReader &body, uint64_t length, bool chunked);
  void HandleMedia(Conn &c, const std::string &id);
};

Server::Server(ServerConfig config, ServerEvents events) : m_shared(std::make_shared<Shared>()) {
  m_shared->config = std::move(config);
  m_shared->events = std::move(events);
}

Server::~Server() {
  Stop();
}

uint16_t Server::Port() const {
  return m_shared->port.load();
}

const ServerConfig &Server::Config() const {
  return m_shared->config;
}

bool Server::Start(std::string &error) {
  if (m_shared->running)
    return true;
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    error = "WSAStartup failed";
    return false;
  }
#endif
  NativeSocket s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == kInvalid) {
    error = "socket() failed";
    return false;
  }
#ifndef _WIN32
  int yes = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&yes), sizeof(yes));
#endif

  uint16_t first = m_shared->config.preferredPort;
  int attempts = first == 0 ? 1 : 11;
  bool bound = false;
  for (int i = 0; i < attempts && !bound; ++i) {
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(static_cast<uint16_t>(first == 0 ? 0 : first + i));
    bound = ::bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0;
  }
  if (!bound || ::listen(s, 16) != 0) {
    CloseNative(s);
    error = "Could not listen on port " + std::to_string(first) + " (or the next 10)";
    return false;
  }
  sockaddr_in actual{};
#ifdef _WIN32
  int len = sizeof(actual);
#else
  socklen_t len = sizeof(actual);
#endif
  getsockname(s, reinterpret_cast<sockaddr *>(&actual), &len);
  m_shared->port = ntohs(actual.sin_port);
  m_shared->listenSocket = s;
  m_shared->running = true;

  std::shared_ptr<Shared> shared = m_shared;
  m_acceptThread = std::thread([shared, s]() {
    while (shared->running) {
      sockaddr_in peer{};
#ifdef _WIN32
      int plen = sizeof(peer);
#else
      socklen_t plen = sizeof(peer);
#endif
      NativeSocket c = ::accept(s, reinterpret_cast<sockaddr *>(&peer), &plen);
      if (c == kInvalid) {
        if (!shared->running)
          break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        continue;
      }
      bool loopback = (ntohl(peer.sin_addr.s_addr) >> 24) == 127;
#ifdef _WIN32
      DWORD tv = kSocketTimeoutMs;
#else
      timeval tv{kSocketTimeoutMs / 1000, 0};
#endif
      setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&tv), sizeof(tv));
      setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&tv), sizeof(tv));
      std::thread([shared, c, loopback]() { shared->HandleConnection(c, loopback); }).detach();
    }
  });
  return true;
}

void Server::Stop() {
  if (!m_shared->running.exchange(false))
    return;
  NativeSocket s = m_shared->listenSocket;
  m_shared->listenSocket = kInvalid;
#ifdef _WIN32
  CloseNative(s);
#else
  ::shutdown(s, SHUT_RDWR);
  CloseNative(s);
#endif
  if (m_acceptThread.joinable())
    m_acceptThread.join();
#ifdef _WIN32
  WSACleanup();
#endif
}

void Server::Shared::HandleConnection(NativeSocket s, bool loopback) {
  Conn c(s);
  std::string head;
  if (!c.ReadHeaderBlock(head)) {
    SendError(c, 431, "bad or oversized request header");
    return;
  }
  Request req;
  if (!ParseRequest(head, req)) {
    SendError(c, 400, "malformed request");
    return;
  }

  // Loopback-only media route used by the desktop UI itself.
  const std::string mediaPrefix = "/media/";
  if (req.method == "GET" && req.path.rfind(mediaPrefix, 0) == 0) {
    if (!loopback) {
      SendError(c, 403, "media is only served to this computer");
      return;
    }
    HandleMedia(c, req.path.substr(mediaPrefix.size()));
    return;
  }

  if (!ConstantTimeEquals(req.Header("x-flick-token"), config.token)) {
    SendError(c, 401, "bad token: re-pair your phone");
    return;
  }

  bool chunked = ToLower(req.Header("transfer-encoding")).find("chunked") != std::string::npos;
  uint64_t length = 0;
  bool hasLength = ParseUint64(req.Header("content-length"), length);
  BodyReader body(c, chunked, hasLength ? length : 0);

  auto continueIfAsked = [&]() {
    if (ToLower(req.Header("expect")) == "100-continue")
      c.SendAll(std::string("HTTP/1.1 100 Continue\r\n\r\n"));
  };

  if (req.path == "/hello") {
    if (req.method != "GET") {
      SendError(c, 405, "use GET");
      return;
    }
    HandleHello(c);
    return;
  }
  if (req.path == "/flick") {
    if (req.method != "POST") {
      SendError(c, 405, "use POST");
      return;
    }
    if (!chunked && !hasLength) {
      SendError(c, 411, "Content-Length required");
      return;
    }
    if (!chunked && length > config.maxMetaBytes) {
      SendError(c, 413, "metadata too large");
      return;
    }
    continueIfAsked();
    HandleFlick(c, req, body, length);
    return;
  }
  const std::string flickPrefix = "/flick/";
  const std::string contentSuffix = "/content";
  if (req.path.rfind(flickPrefix, 0) == 0 && req.path.size() > flickPrefix.size() + contentSuffix.size() &&
      req.path.compare(req.path.size() - contentSuffix.size(), contentSuffix.size(), contentSuffix) == 0) {
    std::string id =
        req.path.substr(flickPrefix.size(), req.path.size() - flickPrefix.size() - contentSuffix.size());
    if (req.method != "PUT" && req.method != "POST") {
      SendError(c, 405, "use PUT");
      return;
    }
    if (!IsValidId(id)) {
      SendError(c, 400, "invalid flick id");
      return;
    }
    if (!chunked && !hasLength) {
      SendError(c, 411, "Content-Length required");
      return;
    }
    if (!chunked && length > config.maxUploadBytes) {
      SendError(c, 413, "file too large");
      return;
    }
    continueIfAsked();
    HandleUpload(c, req, id, body, length, chunked);
    return;
  }
  SendError(c, 404, "no such route");
}

void Server::Shared::HandleHello(Conn &c) {
  SendResponse(
      c, 200, "{\"app\":\"flicksend\",\"protocol\":1,\"name\":\"" + JsonEscape(config.deviceName) + "\"}");
}

void Server::Shared::HandleFlick(Conn &c, const Request &, BodyReader &body, uint64_t) {
  std::string json;
  std::vector<char> buf(kIoChunk);
  for (;;) {
    long long r = body.Read(buf.data(), buf.size());
    if (r < 0) {
      SendError(c, 400, "failed reading body");
      return;
    }
    if (r == 0)
      break;
    json.append(buf.data(), static_cast<size_t>(r));
    if (json.size() > config.maxMetaBytes) {
      SendError(c, 413, "metadata too large");
      return;
    }
  }
  std::string trimmed = Trim(json);
  if (trimmed.empty() || trimmed.front() != '{' || trimmed.back() != '}') {
    SendError(c, 400, "expected a JSON object");
    return;
  }
  if (events.onIncoming)
    events.onIncoming(trimmed);
  SendResponse(c, 200, "{\"ok\":true}");
}

void Server::Shared::HandleUpload(
    Conn &c,
    const Request &req,
    const std::string &id,
    BodyReader &body,
    uint64_t length,
    bool chunked) {
  auto fail = [&](int status, const std::string &msg) {
    if (events.onError)
      events.onError(id, msg);
    SendError(c, status, msg);
  };

  std::error_code ec;
  std::filesystem::create_directories(config.saveDir, ec);
  if (ec) {
    fail(500, "cannot create save folder");
    return;
  }
  std::string mime = req.Header("content-type");
  std::string fileName = Timestamp() + "-" + SanitizeFileName(UrlDecode(req.Header("x-flick-name")), mime);
  std::filesystem::path finalPath = UniquePath(config.saveDir, fileName);
  std::filesystem::path partPath = finalPath;
  partPath += ".part";

  uint64_t total = chunked ? 0 : length;
  uint64_t received = 0;
  {
    std::ofstream out(partPath, std::ios::binary | std::ios::trunc);
    if (!out) {
      fail(500, "cannot write file");
      return;
    }
    std::vector<char> buf(kIoChunk);
    auto lastReport = std::chrono::steady_clock::now();
    if (events.onProgress)
      events.onProgress(id, 0, total);
    for (;;) {
      long long r = body.Read(buf.data(), buf.size());
      if (r < 0) {
        out.close();
        std::filesystem::remove(partPath, ec);
        fail(400, "upload interrupted");
        return;
      }
      if (r == 0)
        break;
      out.write(buf.data(), static_cast<std::streamsize>(r));
      if (!out) {
        out.close();
        std::filesystem::remove(partPath, ec);
        fail(500, "disk write failed");
        return;
      }
      received += static_cast<uint64_t>(r);
      if (received > config.maxUploadBytes) {
        out.close();
        std::filesystem::remove(partPath, ec);
        fail(413, "file too large");
        return;
      }
      auto now = std::chrono::steady_clock::now();
      if (events.onProgress && now - lastReport > std::chrono::milliseconds(150)) {
        lastReport = now;
        events.onProgress(id, received, total);
      }
    }
  }
  std::filesystem::rename(partPath, finalPath, ec);
  if (ec) {
    std::filesystem::remove(partPath, ec);
    fail(500, "cannot finalize file");
    return;
  }
  {
    std::lock_guard<std::mutex> lock(mediaMutex);
    media[id] = MediaEntry{finalPath, mime.empty() ? "application/octet-stream" : mime};
  }
  if (events.onProgress)
    events.onProgress(id, received, chunked ? received : total);
  if (events.onComplete)
    events.onComplete(id, finalPath);
  SendResponse(c, 200, "{\"ok\":true}");
}

void Server::Shared::HandleMedia(Conn &c, const std::string &id) {
  MediaEntry entry;
  {
    std::lock_guard<std::mutex> lock(mediaMutex);
    auto it = media.find(id);
    if (it == media.end()) {
      SendError(c, 404, "unknown media id");
      return;
    }
    entry = it->second;
  }
  std::ifstream in(entry.file, std::ios::binary);
  std::error_code ec;
  uint64_t size = std::filesystem::file_size(entry.file, ec);
  if (!in || ec) {
    SendError(c, 404, "file is gone");
    return;
  }
  std::string head = "HTTP/1.1 200 OK\r\nContent-Type: " + entry.mime + "\r\nContent-Length: " + std::to_string(size) +
      "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
  if (!c.SendAll(head))
    return;
  std::vector<char> buf(kIoChunk);
  while (in) {
    in.read(buf.data(), static_cast<std::streamsize>(buf.size()));
    std::streamsize got = in.gcount();
    if (got <= 0)
      break;
    if (!c.SendAll(buf.data(), static_cast<size_t>(got)))
      return;
  }
}

} // namespace flicksend
