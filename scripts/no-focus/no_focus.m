// Test-only interposer: loaded into nsh's AppKit TEST host (DYLD_INSERT_LIBRARIES, set by scripts/shots-mac.mjs and
// scripts/nsh-test-mac.sh) so a test window never takes the keyboard focus from the person who is working. nsh's host
// calls activateIgnoringOtherApps / activate when it opens a window and on every injected press, and makeKeyAndOrderFront
// for its window. Here those calls are no-ops, the window is never ordered on screen (app.screenshot still renders the
// view tree), and the activation policy is Prohibited (the app can never become the active one). Measured with
// NSWorkspace.frontmostApplication: the host was never the front app. Never shipped: the release app is not started with
// this library. NO_FOCUS_LOG=<file> logs what was blocked.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

static void note(const char *what) {
  const char *log = getenv("NO_FOCUS_LOG");
  if (!log) return;
  FILE *f = fopen(log, "a");
  if (f) { fprintf(f, "%s\n", what); fclose(f); }
}

static void swap(Class c, SEL sel, IMP imp) {
  Method m = class_getInstanceMethod(c, sel);
  if (m) method_setImplementation(m, imp);
}

static void noActivateIgnoring(id self, SEL _cmd, BOOL flag) { note("blocked activateIgnoringOtherApps"); }
static void noActivate(id self, SEL _cmd) { note("blocked activate"); }
static BOOL (*realPolicy)(id, SEL, NSApplicationActivationPolicy);
static BOOL accessory(id self, SEL _cmd, NSApplicationActivationPolicy p) {
  return realPolicy(self, _cmd, NSApplicationActivationPolicyProhibited);
}
static void behind(id self, SEL _cmd, id sender) { note("makeKeyAndOrderFront -> not shown"); }
static BOOL (*realActivate)(id, SEL, NSApplicationActivationOptions);
static BOOL noActivateOptions(id self, SEL _cmd, NSApplicationActivationOptions o) { note("blocked activateWithOptions"); return NO; }
static void (*realOrderFront)(id, SEL, id);
static void orderFrontBehind(id self, SEL _cmd, id sender) { note("orderFront -> not shown"); }

__attribute__((constructor)) static void install(void) {
  const char *log = getenv("NO_FOCUS_LOG");
  if (log) { FILE *f = fopen(log, "a"); if (f) { fprintf(f, "no_focus loaded in pid %d\n", getpid()); fclose(f); } }
  Method pol = class_getInstanceMethod([NSApplication class], @selector(setActivationPolicy:));
  if (pol) { realPolicy = (void *)method_getImplementation(pol); method_setImplementation(pol, (IMP)accessory); }
  swap([NSApplication class], @selector(activateIgnoringOtherApps:), (IMP)noActivateIgnoring);
  if ([NSApplication instancesRespondToSelector:@selector(activate)]) swap([NSApplication class], @selector(activate), (IMP)noActivate);
  swap([NSWindow class], @selector(makeKeyAndOrderFront:), (IMP)behind);
  swap([NSWindow class], @selector(orderFrontRegardless), (IMP)noActivate);
  swap([NSWindow class], @selector(orderFront:), (IMP)orderFrontBehind);
  swap([NSRunningApplication class], @selector(activateWithOptions:), (IMP)noActivateOptions);
}
