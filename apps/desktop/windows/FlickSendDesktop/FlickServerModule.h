// FlickServer: React Native Windows turbo module exposing the LAN receiver
// (server/FlickServerCore) and a few window/shell helpers to JS.
//
// JS API (see src/native.ts):
//   start(): Promise<string>        JSON {port, token, name, hosts[], saveDir}
//   setOverlay(on: boolean): void   full-screen, always-on-top "stage" on the primary monitor
//   openFile(path: string): void    open in the default app (used for videos)
//   revealFile(path: string): void  show in Explorer
// Events (DeviceEventEmitter, payload is a JSON string):
//   flickIncoming, flickProgress, flickComplete, flickError
#pragma once

#include "NativeModules.h"

#include <functional>
#include <string>

namespace FlickSendDesktop {

REACT_MODULE(FlickServer)
struct FlickServer {
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &reactContext) noexcept;

  REACT_METHOD(Start, L"start")
  void Start(winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept;

  REACT_METHOD(SetOverlay, L"setOverlay")
  void SetOverlay(bool on) noexcept;

  REACT_METHOD(OpenFile, L"openFile")
  void OpenFile(std::string path) noexcept;

  REACT_METHOD(RevealFile, L"revealFile")
  void RevealFile(std::string path) noexcept;

  REACT_EVENT(OnIncoming, L"flickIncoming")
  std::function<void(std::string)> OnIncoming;

  REACT_EVENT(OnProgress, L"flickProgress")
  std::function<void(std::string)> OnProgress;

  REACT_EVENT(OnComplete, L"flickComplete")
  std::function<void(std::string)> OnComplete;

  REACT_EVENT(OnError, L"flickError")
  std::function<void(std::string)> OnError;

 private:
  winrt::Microsoft::ReactNative::ReactContext m_context;
};

} // namespace FlickSendDesktop
