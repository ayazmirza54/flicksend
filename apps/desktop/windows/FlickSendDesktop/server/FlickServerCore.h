// FlickServerCore: a tiny, dependency-free HTTP/1.1 receiver for FlickSend.
//
// Portable C++17 (Winsock on Windows, BSD sockets elsewhere) so it can be unit
// and integration tested on any OS. The React Native Windows module
// (FlickServerModule) wraps it and forwards events to JS.
//
// Routes (see shared/protocol.ts):
//   GET  /hello                 token required
//   POST /flick                 token required, JSON body forwarded verbatim
//   PUT  /flick/:id/content     token required, raw body streamed to disk
//   GET  /media/:id             loopback peers only, serves received files
#pragma once

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

namespace flicksend {

using SocketHandle = std::uintptr_t;

struct ServerConfig {
  std::string token;
  // 0 = let the OS pick (used by tests). Otherwise tries this port and the next 10.
  uint16_t preferredPort = 47821;
  std::filesystem::path saveDir;
  std::string deviceName = "Laptop";
  uint64_t maxUploadBytes = 8ull * 1024 * 1024 * 1024;
  uint64_t maxMetaBytes = 4ull * 1024 * 1024;
};

struct ServerEvents {
  // Raw JSON body of POST /flick.
  std::function<void(const std::string &metaJson)> onIncoming;
  std::function<void(const std::string &id, uint64_t received, uint64_t total)> onProgress;
  std::function<void(const std::string &id, const std::filesystem::path &file)> onComplete;
  std::function<void(const std::string &id, const std::string &error)> onError;
};

struct MediaEntry {
  std::filesystem::path file;
  std::string mime;
};

class Server {
 public:
  Server(ServerConfig config, ServerEvents events);
  ~Server();
  Server(const Server &) = delete;
  Server &operator=(const Server &) = delete;

  bool Start(std::string &error);
  void Stop();
  uint16_t Port() const;
  const ServerConfig &Config() const;

  struct Shared; // implementation state shared with connection threads

 private:
  std::shared_ptr<Shared> m_shared;
  std::thread m_acceptThread;
};

// ---- helpers (exposed for tests) ----
std::string GenerateToken();
std::string LoadOrCreateToken(const std::filesystem::path &file);
std::string JsonEscape(const std::string &s);
std::string UrlDecode(const std::string &s);
std::string SanitizeFileName(const std::string &name, const std::string &mime);
std::string ExtensionForMime(const std::string &mime);
bool IsValidId(const std::string &id);
bool ConstantTimeEquals(const std::string &a, const std::string &b);

} // namespace flicksend
