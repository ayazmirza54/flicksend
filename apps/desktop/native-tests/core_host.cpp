// Test host for FlickServerCore. Builds on Linux/macOS/Windows.
//
//   core_host --selftest                 run helper unit tests
//   core_host <saveDir> <token>          run the server on an OS-chosen port;
//                                        prints one JSON line per event to stdout
//                                        and exits when stdin closes.
#include "../windows/FlickSendDesktop/server/FlickServerCore.h"

#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>

using namespace flicksend;

static int g_failures = 0;
#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                                       \
    }                                                                     \
  } while (0)

static int SelfTest() {
  CHECK(IsValidId("abcd1234"));
  CHECK(IsValidId("lq3k9z-AbCdEfGhIjKl"));
  CHECK(!IsValidId("short"));
  CHECK(!IsValidId("../../etc/passwd"));
  CHECK(!IsValidId("abc def 123"));

  CHECK(SanitizeFileName("IMG_0001.JPG", "image/jpeg") == "IMG_0001.jpg");
  CHECK(SanitizeFileName("../../evil.exe", "image/png") == "evil.exe");
  CHECK(SanitizeFileName("..\\..\\x.png", "image/png") == "x.png");
  CHECK(SanitizeFileName("", "video/mp4") == "flick.mp4");
  CHECK(SanitizeFileName("my holiday clip", "video/quicktime") == "my_holiday_clip.mov");
  CHECK(SanitizeFileName("\xe5\x86\x99\xe7\x9c\x9f.jpg", "image/jpeg") == "flick.jpg");
  CHECK(SanitizeFileName("....", "image/png") == "flick.png");

  CHECK(ExtensionForMime("image/png") == ".png");
  CHECK(ExtensionForMime("VIDEO/MP4; codecs=avc1") == ".mp4");
  CHECK(ExtensionForMime("video/unknown") == ".mp4");
  CHECK(ExtensionForMime("application/zip") == ".bin");

  CHECK(UrlDecode("a%20b+c%2Fd") == "a b c/d");
  CHECK(UrlDecode("%zz") == "%zz");

  CHECK(JsonEscape("a\"b\\c\n\x01") == "a\\\"b\\\\c\\n\\u0001");

  CHECK(ConstantTimeEquals("abc", "abc"));
  CHECK(!ConstantTimeEquals("abc", "abd"));
  CHECK(!ConstantTimeEquals("abc", "abcd"));
  CHECK(!ConstantTimeEquals("", "x"));

  std::string t = GenerateToken();
  CHECK(t.size() == 32);
  CHECK(t != GenerateToken());

  std::printf(g_failures == 0 ? "selftest ok\n" : "selftest FAILED (%d)\n", g_failures);
  return g_failures == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--selftest")
    return SelfTest();
  if (argc != 3) {
    std::fprintf(stderr, "usage: core_host <saveDir> <token> | --selftest\n");
    return 2;
  }
  std::mutex outMutex;
  auto emit = [&](const std::string &line) {
    std::lock_guard<std::mutex> lock(outMutex);
    std::cout << line << std::endl;
  };

  ServerConfig config;
  config.saveDir = argv[1];
  config.token = argv[2];
  config.preferredPort = 0;
  config.deviceName = "Test \"Laptop\"";
  config.maxUploadBytes = 64ull * 1024 * 1024;

  ServerEvents events;
  events.onIncoming = [&](const std::string &json) { emit("{\"event\":\"incoming\",\"meta\":" + json + "}"); };
  events.onProgress = [&](const std::string &id, uint64_t received, uint64_t total) {
    emit("{\"event\":\"progress\",\"id\":\"" + JsonEscape(id) + "\",\"received\":" + std::to_string(received) +
         ",\"total\":" + std::to_string(total) + "}");
  };
  events.onComplete = [&](const std::string &id, const std::filesystem::path &file) {
    emit("{\"event\":\"complete\",\"id\":\"" + JsonEscape(id) + "\",\"path\":\"" + JsonEscape(file.string()) + "\"}");
  };
  events.onError = [&](const std::string &id, const std::string &error) {
    emit("{\"event\":\"error\",\"id\":\"" + JsonEscape(id) + "\",\"error\":\"" + JsonEscape(error) + "\"}");
  };

  Server server(config, events);
  std::string err;
  if (!server.Start(err)) {
    std::fprintf(stderr, "start failed: %s\n", err.c_str());
    return 1;
  }
  emit("{\"event\":\"ready\",\"port\":" + std::to_string(server.Port()) + "}");

  std::string line;
  while (std::getline(std::cin, line)) {
  }
  server.Stop();
  return 0;
}
