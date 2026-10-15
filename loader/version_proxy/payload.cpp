/* payload.cpp -- BetterNCM(v3) loader payload started by the version.dll proxy.
 *
 * Milestone 1 (this file, as written): prove the proxy reaches every cloudmusic.exe
 * process, classify the process from its Chromium command line, and write a durable log.
 * That is the evidence needed for acceptance items T1/T3/T6 in docs/04-antitamper.md.
 *
 * Milestone 2 (next): in the renderer branch, install the libcef hooks and inject the JS
 * bootstrap.  The hook surface is the five exports BetterNCM v2 uses, all resolved by name
 * so no CEF headers are needed for the discovery step:
 *
 *     cef_initialize
 *     cef_execute_process
 *     cef_browser_host_create_browser_sync
 *     cef_register_scheme_handler_factory
 *     cef_v8context_get_current_context
 *
 * The bootstrap target page is the same as v2 and still served by 3.1.41:
 *     orpheus://orpheus/pub/app.html
 *
 * Placeholder names below intentionally mirror v2 so the port stays reviewable.
 */

#include <windows.h>
#include <string>

#pragma comment(lib, "User32.lib")    // wsprintfW

namespace {

enum class ProcessType { Main, Renderer, Gpu, Utility, Unknown };

const wchar_t* ProcessTypeName(ProcessType t) {
    switch (t) {
        case ProcessType::Main:     return L"Main";
        case ProcessType::Renderer: return L"Renderer";
        case ProcessType::Gpu:      return L"GpuProcess";
        case ProcessType::Utility:  return L"Utility";
        default:                    return L"Unknown";
    }
}

/** Chromium tags the child processes on the command line; the main process has no --type. */
ProcessType DetectProcessType(const std::wstring& cmdline) {
    if (cmdline.find(L"--type=renderer") != std::wstring::npos) return ProcessType::Renderer;
    if (cmdline.find(L"--type=gpu-process") != std::wstring::npos) return ProcessType::Gpu;
    if (cmdline.find(L"--type=utility") != std::wstring::npos) return ProcessType::Utility;
    if (cmdline.find(L"--type=") != std::wstring::npos) return ProcessType::Unknown;
    return ProcessType::Main;
}

std::wstring EnvOrEmpty(const wchar_t* name) {
    DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
    if (n == 0) return {};
    std::wstring v(n, L'\0');
    DWORD got = GetEnvironmentVariableW(name, v.data(), n);
    v.resize(got);
    return v;
}

/** Log directory: %BNCM_LOG_DIR% > %BETTERNCM_PROFILE% > %LOCALAPPDATA%\BetterNCM.
 *  Deliberately not C:\betterncm (the upstream default) so that milestone-1 probing never
 *  requires write access to a drive root. */
std::wstring LogDir() {
    std::wstring d = EnvOrEmpty(L"BNCM_LOG_DIR");
    if (!d.empty()) return d;
    d = EnvOrEmpty(L"BETTERNCM_PROFILE");
    if (!d.empty()) return d + L"\\logs";
    wchar_t buf[MAX_PATH] = {};
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
    if (n == 0) return L".\\bncm-logs";
    return std::wstring(buf) + L"\\BetterNCM\\logs";
}

void EnsureDirectory(const std::wstring& dir) {
    // Create the leaf and its parent; two levels is all we ever need here.
    std::wstring parent = dir;
    size_t pos = parent.find_last_of(L'\\');
    if (pos != std::wstring::npos && pos > 2) {
        CreateDirectoryW(parent.substr(0, pos).c_str(), nullptr);
    }
    CreateDirectoryW(dir.c_str(), nullptr);
}

void AppendLog(const std::wstring& line) {
    const std::wstring dir = LogDir();
    EnsureDirectory(dir);
    const std::wstring path = dir + L"\\loader.log";

    HANDLE f = CreateFileW(path.c_str(), FILE_APPEND_DATA,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;

    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t stamp[64];
    wsprintfW(stamp, L"%04u-%02u-%02u %02u:%02u:%02u.%03u ",
              st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);

    std::wstring body(stamp);
    body += line;
    body += L"\r\n";

    // Emit UTF-8 so the log is readable regardless of the console code page.
    int need = WideCharToMultiByte(CP_UTF8, 0, body.c_str(), (int)body.size(),
                                   nullptr, 0, nullptr, nullptr);
    if (need > 0) {
        std::string utf8(static_cast<size_t>(need), '\0');
        WideCharToMultiByte(CP_UTF8, 0, body.c_str(), (int)body.size(),
                            utf8.data(), need, nullptr, nullptr);
        DWORD written = 0;
        WriteFile(f, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
    }
    CloseHandle(f);
}

/** Report whether our own module is mapped in this process, and where from. */
std::wstring SelfPath() {
    HMODULE self = nullptr;
    // Any address inside the payload works; use the address of this function's module.
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCWSTR>(&AppendLog), &self);
    wchar_t path[MAX_PATH] = {};
    if (!self || GetModuleFileNameW(self, path, MAX_PATH) == 0) return L"<unknown>";
    return path;
}

/** Confirm the genuine version.dll is mapped as a module distinct from our proxy.
 *
 *  A name-only lookup is not good enough here: GetModuleHandleW(L"version.dll") returns
 *  whichever module was registered under that base name first, i.e. our own proxy.  We
 *  must ask for the system path explicitly to know whether the real DLL really loaded.
 *  Verified on 3.1.41.205529: both E:\CloudMusic\VERSION.dll and
 *  C:\WINDOWS\system32\version.dll are mapped, so the forwarders are not self-referential. */
bool RealVersionDllLoaded(std::wstring* out) {
    wchar_t sysdir[MAX_PATH] = {};
    if (GetSystemDirectoryW(sysdir, MAX_PATH) == 0) return false;
    std::wstring path(sysdir);
    path += L"\\version.dll";

    HMODULE m = nullptr;
    if (!GetModuleHandleExW(0, path.c_str(), &m) || !m) return false;
    if (out) *out = path;
    return true;
}

}  // namespace

void BncmPayloadMain(HMODULE self) {
    (void)self;

    if (!EnvOrEmpty(L"BETTERNCM_DISABLED_FLAG").empty()) return;

    const std::wstring cmdline = GetCommandLineW() ? GetCommandLineW() : L"";
    const std::wstring self_path = SelfPath();

    wchar_t host[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, host, MAX_PATH);

    wchar_t proxy_path[MAX_PATH] = {};
    GetModuleFileNameW(self, proxy_path, MAX_PATH);

    const ProcessType type = DetectProcessType(cmdline);

    std::wstring real_version;
    const bool real_ok = RealVersionDllLoaded(&real_version);

    wchar_t line[2048];
    wsprintfW(line,
              L"pid=%lu type=%s host=%s proxy=%s real_version_dll=%s(%s) cmdline_len=%u",
              GetCurrentProcessId(), ProcessTypeName(type), host, proxy_path,
              real_ok ? L"loaded" : L"MISSING",
              real_version.empty() ? L"?" : real_version.c_str(),
              (unsigned)cmdline.size());
    AppendLog(line);

    // Milestone 2 hooks go here:
    //     if (type == ProcessType::Renderer) { InstallCefHooks(); InjectBootstrap(); }
    // Kept as a log-only stub so milestone 1 cannot destabilise the client.
    if (type == ProcessType::Renderer) {
        AppendLog(L"  [stub] renderer branch reached; CEF hook install not enabled yet");
    }
}
