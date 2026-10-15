/* proxy.cpp -- AheadLib-style proxy for version.dll.
 *
 * Why this file exists
 * --------------------
 * cloudmusic.dll (NetEase Cloud Music 3.1.41.205529) statically imports VERSION.dll.
 * version.dll is NOT a KnownDLL, so the Windows loader satisfies that import from the
 * application directory first.  Dropping this DLL as <NCM install>\version.dll therefore
 * gets us code execution inside every cloudmusic.exe process, with no modification to any
 * signed NetEase file.
 *
 * Why the name is version.dll and not msimg32.dll
 * -----------------------------------------------
 * cloudmusic.dll also imports MSIMG32.dll, which is the filename upstream BetterNCM uses.
 * But 3.1.41 contains a hard-coded third-party-plugin check for the literal name
 * "msimg32.dll" (orpheus::storage::StatisLog::CheckThirdPluginHook, telemetry field
 * `existThirdPlugin`, emitted during appInit).  Using that name trips the check, so we use
 * version.dll instead.  See docs/04-antitamper.md.
 *
 * Design notes
 * ------------
 *  - The 17 exports are forwarded to the genuine %SystemRoot%\System32\version.dll through
 *    function pointers resolved at load time.  Signatures come from <winver.h>.
 *  - This is an x64-only target (the NetEase build is 64-bit), so a mis-declared argument
 *    list cannot corrupt the stack; the first four integer/pointer arguments travel in
 *    registers under the Microsoft x64 convention.
 *  - We deliberately do NOT call DisableThreadLibraryCalls' payload on DLL_THREAD_ATTACH:
 *    nothing needs it, and keeping the payload out of that path avoids re-entrancy while
 *    the loader lock is held.
 */

#include <windows.h>
#include <winver.h>
#include <shlwapi.h>
#include <string>

#pragma comment(lib, "Shlwapi.lib")   // PathFindFileNameW
#pragma comment(lib, "User32.lib")    // MessageBoxA/W, wsprintfA

// ---------------------------------------------------------------------------
// exports of the genuine version.dll (verified against System32\version.dll:
// 17 named exports, ordinal base 1)
// ---------------------------------------------------------------------------

#pragma comment(linker, "/EXPORT:GetFileVersionInfoA=Proxy_GetFileVersionInfoA,@1")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoByHandle=Proxy_GetFileVersionInfoByHandle,@2")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoExA=Proxy_GetFileVersionInfoExA,@3")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoExW=Proxy_GetFileVersionInfoExW,@4")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoSizeA=Proxy_GetFileVersionInfoSizeA,@5")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoSizeExA=Proxy_GetFileVersionInfoSizeExA,@6")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoSizeExW=Proxy_GetFileVersionInfoSizeExW,@7")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoSizeW=Proxy_GetFileVersionInfoSizeW,@8")
#pragma comment(linker, "/EXPORT:GetFileVersionInfoW=Proxy_GetFileVersionInfoW,@9")
#pragma comment(linker, "/EXPORT:VerFindFileA=Proxy_VerFindFileA,@10")
#pragma comment(linker, "/EXPORT:VerFindFileW=Proxy_VerFindFileW,@11")
#pragma comment(linker, "/EXPORT:VerInstallFileA=Proxy_VerInstallFileA,@12")
#pragma comment(linker, "/EXPORT:VerInstallFileW=Proxy_VerInstallFileW,@13")
#pragma comment(linker, "/EXPORT:VerLanguageNameA=Proxy_VerLanguageNameA,@14")
#pragma comment(linker, "/EXPORT:VerLanguageNameW=Proxy_VerLanguageNameW,@15")
#pragma comment(linker, "/EXPORT:VerQueryValueA=Proxy_VerQueryValueA,@16")
#pragma comment(linker, "/EXPORT:VerQueryValueW=Proxy_VerQueryValueW,@17")

namespace {

HMODULE g_real = nullptr;

/** Load the genuine version.dll from the system directory (never from the app dir). */
bool LoadRealVersionDll() {
    wchar_t sysdir[MAX_PATH] = {};
    const UINT n = GetSystemDirectoryW(sysdir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return false;

    std::wstring path(sysdir);
    path += L"\\version.dll";

    g_real = LoadLibraryW(path.c_str());
    if (!g_real) {
        // Fail loudly rather than half-load: an export-complete proxy that silently
        // resolves to nothing would break every version query in the host.
        MessageBoxW(nullptr, path.c_str(),
                    L"BetterNCM(v3) proxy: cannot load the system version.dll",
                    MB_ICONSTOP | MB_OK);
        return false;
    }
    return true;
}

template <typename T>
T Resolve(const char* name) {
    FARPROC p = g_real ? GetProcAddress(g_real, name) : nullptr;
    if (!p) {
        char msg[256];
        wsprintfA(msg, "version.dll: missing export %s", name);
        MessageBoxA(nullptr, msg, "BetterNCM(v3) proxy", MB_ICONSTOP | MB_OK);
        ExitProcess(static_cast<UINT>(-2));
    }
    return reinterpret_cast<T>(p);
}

// Resolved lazily so that a host which never queries version info pays nothing.
struct Api {
    decltype(&GetFileVersionInfoA) pGetFileVersionInfoA = nullptr;
    decltype(&GetFileVersionInfoExA) pGetFileVersionInfoExA = nullptr;
    decltype(&GetFileVersionInfoExW) pGetFileVersionInfoExW = nullptr;
    decltype(&GetFileVersionInfoSizeA) pGetFileVersionInfoSizeA = nullptr;
    decltype(&GetFileVersionInfoSizeExA) pGetFileVersionInfoSizeExA = nullptr;
    decltype(&GetFileVersionInfoSizeExW) pGetFileVersionInfoSizeExW = nullptr;
    decltype(&GetFileVersionInfoSizeW) pGetFileVersionInfoSizeW = nullptr;
    decltype(&GetFileVersionInfoW) pGetFileVersionInfoW = nullptr;
    decltype(&VerFindFileA) pVerFindFileA = nullptr;
    decltype(&VerFindFileW) pVerFindFileW = nullptr;
    decltype(&VerInstallFileA) pVerInstallFileA = nullptr;
    decltype(&VerInstallFileW) pVerInstallFileW = nullptr;
    decltype(&VerLanguageNameA) pVerLanguageNameA = nullptr;
    decltype(&VerLanguageNameW) pVerLanguageNameW = nullptr;
    decltype(&VerQueryValueA) pVerQueryValueA = nullptr;
    decltype(&VerQueryValueW) pVerQueryValueW = nullptr;
    // Not declared by <winver.h>; internal export, documented shape is
    // BOOL WINAPI GetFileVersionInfoByHandle(DWORD, HANDLE, LPVOID, DWORD).
    BOOL(WINAPI* pGetFileVersionInfoByHandle)(DWORD, HANDLE, LPVOID, DWORD) = nullptr;
    bool ready = false;

    void Ensure() {
        if (ready) return;
        pGetFileVersionInfoA = Resolve<decltype(pGetFileVersionInfoA)>("GetFileVersionInfoA");
        pGetFileVersionInfoExA = Resolve<decltype(pGetFileVersionInfoExA)>("GetFileVersionInfoExA");
        pGetFileVersionInfoExW = Resolve<decltype(pGetFileVersionInfoExW)>("GetFileVersionInfoExW");
        pGetFileVersionInfoSizeA = Resolve<decltype(pGetFileVersionInfoSizeA)>("GetFileVersionInfoSizeA");
        pGetFileVersionInfoSizeExA = Resolve<decltype(pGetFileVersionInfoSizeExA)>("GetFileVersionInfoSizeExA");
        pGetFileVersionInfoSizeExW = Resolve<decltype(pGetFileVersionInfoSizeExW)>("GetFileVersionInfoSizeExW");
        pGetFileVersionInfoSizeW = Resolve<decltype(pGetFileVersionInfoSizeW)>("GetFileVersionInfoSizeW");
        pGetFileVersionInfoW = Resolve<decltype(pGetFileVersionInfoW)>("GetFileVersionInfoW");
        pVerFindFileA = Resolve<decltype(pVerFindFileA)>("VerFindFileA");
        pVerFindFileW = Resolve<decltype(pVerFindFileW)>("VerFindFileW");
        pVerInstallFileA = Resolve<decltype(pVerInstallFileA)>("VerInstallFileA");
        pVerInstallFileW = Resolve<decltype(pVerInstallFileW)>("VerInstallFileW");
        pVerLanguageNameA = Resolve<decltype(pVerLanguageNameA)>("VerLanguageNameA");
        pVerLanguageNameW = Resolve<decltype(pVerLanguageNameW)>("VerLanguageNameW");
        pVerQueryValueA = Resolve<decltype(pVerQueryValueA)>("VerQueryValueA");
        pVerQueryValueW = Resolve<decltype(pVerQueryValueW)>("VerQueryValueW");
        pGetFileVersionInfoByHandle =
            Resolve<decltype(pGetFileVersionInfoByHandle)>("GetFileVersionInfoByHandle");
        ready = true;
    }
};

Api g_api;

}  // namespace

/** Entry point implemented in payload.cpp. Must live at global scope, not in the
 *  anonymous namespace, or its external linkage is hidden. */
void BncmPayloadMain(HMODULE self);

// ---------------------------------------------------------------------------
// forwarders
// ---------------------------------------------------------------------------

extern "C" {

BOOL WINAPI Proxy_GetFileVersionInfoA(LPCSTR a, DWORD b, DWORD c, LPVOID d) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoA(a, b, c, d);
}
BOOL WINAPI Proxy_GetFileVersionInfoW(LPCWSTR a, DWORD b, DWORD c, LPVOID d) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoW(a, b, c, d);
}
BOOL WINAPI Proxy_GetFileVersionInfoExA(DWORD f, LPCSTR a, DWORD b, DWORD c, LPVOID d) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoExA(f, a, b, c, d);
}
BOOL WINAPI Proxy_GetFileVersionInfoExW(DWORD f, LPCWSTR a, DWORD b, DWORD c, LPVOID d) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoExW(f, a, b, c, d);
}
BOOL WINAPI Proxy_GetFileVersionInfoByHandle(DWORD f, HANDLE h, LPVOID d, DWORD l) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoByHandle(f, h, d, l);
}
DWORD WINAPI Proxy_GetFileVersionInfoSizeA(LPCSTR a, LPDWORD b) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoSizeA(a, b);
}
DWORD WINAPI Proxy_GetFileVersionInfoSizeW(LPCWSTR a, LPDWORD b) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoSizeW(a, b);
}
DWORD WINAPI Proxy_GetFileVersionInfoSizeExA(DWORD f, LPCSTR a, LPDWORD b) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoSizeExA(f, a, b);
}
DWORD WINAPI Proxy_GetFileVersionInfoSizeExW(DWORD f, LPCWSTR a, LPDWORD b) {
    g_api.Ensure(); return g_api.pGetFileVersionInfoSizeExW(f, a, b);
}
DWORD WINAPI Proxy_VerFindFileA(DWORD a, LPCSTR b, LPCSTR c, LPCSTR d, LPSTR e, PUINT f, LPSTR g, PUINT h) {
    g_api.Ensure(); return g_api.pVerFindFileA(a, b, c, d, e, f, g, h);
}
DWORD WINAPI Proxy_VerFindFileW(DWORD a, LPCWSTR b, LPCWSTR c, LPCWSTR d, LPWSTR e, PUINT f, LPWSTR g, PUINT h) {
    g_api.Ensure(); return g_api.pVerFindFileW(a, b, c, d, e, f, g, h);
}
DWORD WINAPI Proxy_VerInstallFileA(DWORD a, LPCSTR b, LPCSTR c, LPCSTR d, LPCSTR e,
                                   LPCSTR f, LPSTR g, PUINT h) {
    g_api.Ensure(); return g_api.pVerInstallFileA(a, b, c, d, e, f, g, h);
}
DWORD WINAPI Proxy_VerInstallFileW(DWORD a, LPCWSTR b, LPCWSTR c, LPCWSTR d, LPCWSTR e,
                                   LPCWSTR f, LPWSTR g, PUINT h) {
    g_api.Ensure(); return g_api.pVerInstallFileW(a, b, c, d, e, f, g, h);
}
DWORD WINAPI Proxy_VerLanguageNameA(DWORD a, LPSTR b, DWORD c) {
    g_api.Ensure(); return g_api.pVerLanguageNameA(a, b, c);
}
DWORD WINAPI Proxy_VerLanguageNameW(DWORD a, LPWSTR b, DWORD c) {
    g_api.Ensure(); return g_api.pVerLanguageNameW(a, b, c);
}
BOOL WINAPI Proxy_VerQueryValueA(LPCVOID a, LPCSTR b, LPVOID* c, PUINT d) {
    g_api.Ensure(); return g_api.pVerQueryValueA(a, b, c, d);
}
BOOL WINAPI Proxy_VerQueryValueW(LPCVOID a, LPCWSTR b, LPVOID* c, PUINT d) {
    g_api.Ensure(); return g_api.pVerQueryValueW(a, b, c, d);
}

}  // extern "C"

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

BOOL APIENTRY DllMain(HMODULE self, DWORD reason, LPVOID /*reserved*/) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;

    DisableThreadLibraryCalls(self);

    if (!LoadRealVersionDll()) return FALSE;

    // Only act inside the NetEase client.  Every other host that happens to load this
    // DLL (for example an installer, or a shell extension) just gets a working
    // version.dll.
    wchar_t self_path[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, self_path, MAX_PATH) == 0) return TRUE;

    PCWSTR base = PathFindFileNameW(self_path);
    if (_wcsicmp(base, L"cloudmusic.exe") != 0) return TRUE;

    // Do the payload work on our own thread: DllMain runs under the loader lock, and the
    // payload creates files, allocates a console and (later) hooks libcef.
    HANDLE th = CreateThread(nullptr, 0,
                             [](LPVOID param) -> DWORD {
                                 BncmPayloadMain(static_cast<HMODULE>(param));
                                 return 0;
                             },
                             self, 0, nullptr);
    if (th) CloseHandle(th);
    return TRUE;
}
