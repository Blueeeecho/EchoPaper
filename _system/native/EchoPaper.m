#import <AppKit/AppKit.h>
#include <math.h>

@interface EchoPaperApp : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic,strong) NSWindow *window;
@property(nonatomic,strong) NSTextField *address;
@property(nonatomic,strong) NSButton *openButton;
@property(nonatomic,strong) NSView *overlay;
@property(nonatomic,strong) NSTextField *status;
@property(nonatomic,strong) NSProgressIndicator *progress;
@property(nonatomic,strong) NSURL *workbenchURL;
@property(nonatomic,strong) NSTask *startup;
@property(nonatomic) BOOL probing;
@property(nonatomic) BOOL openAfterReady;
@property(nonatomic) BOOL forceBrowserOpen;
@property(nonatomic) BOOL openingBrowser;
@property(nonatomic,strong) NSURL *workspaceAccessURL;
@end

@implementation EchoPaperApp
- (void)stage:(NSString *)message {
    @synchronized(self){
        NSString *directory=[NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/EchoPaper"];
        [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
        NSString *filename=[directory stringByAppendingPathComponent:@"native-startup.log"];
        if(![[NSFileManager defaultManager] fileExistsAtPath:filename])[[NSFileManager defaultManager] createFileAtPath:filename contents:[NSData data] attributes:nil];
        NSFileHandle *handle=[NSFileHandle fileHandleForWritingAtPath:filename];
        @try{[handle seekToEndOfFile];[handle writeData:[[NSString stringWithFormat:@"%@ pid=%d %@\n",[NSDate date],getpid(),message] dataUsingEncoding:NSUTF8StringEncoding]];[handle closeFile];}@catch(NSException *error){}
    }
}
- (NSURL *)workspace {
    NSString *root = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"EchoPaperWorkspaceRoot"] ?: [NSHomeDirectory() stringByAppendingPathComponent:@"EchoPaper"];
    return [NSURL fileURLWithPath:root isDirectory:YES];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self stage:@"application launched"];
    [self buildMenus];
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,560,380) styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
    self.window.title=@"EchoPaper";self.window.delegate=self;self.window.releasedWhenClosed=NO;
    self.window.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];
    self.window.backgroundColor=[NSColor colorWithRed:0.96 green:0.97 blue:0.99 alpha:1];
    self.overlay=self.window.contentView;
    NSImageView *icon=[[NSImageView alloc] initWithFrame:NSZeroRect];
    icon.image=NSApp.applicationIconImage;
    icon.translatesAutoresizingMaskIntoConstraints=NO;
    [NSLayoutConstraint activateConstraints:@[[icon.widthAnchor constraintEqualToConstant:76],[icon.heightAnchor constraintEqualToConstant:76]]];
    NSTextField *title=[NSTextField labelWithString:@"EchoPaper"];
    title.font=[NSFont systemFontOfSize:30 weight:NSFontWeightSemibold];
    title.textColor=[NSColor colorWithRed:78.0/255 green:95.0/255 blue:135.0/255 alpha:1];
    self.status=[NSTextField labelWithString:@"正在检查本地服务…"];
    self.status.font=[NSFont systemFontOfSize:14];
    self.address=[NSTextField labelWithString:@"本地论文写作与 LaTeX 工作台"];
    self.address.textColor=[NSColor secondaryLabelColor];self.address.selectable=YES;
    self.progress=[NSProgressIndicator new];self.progress.style=NSProgressIndicatorStyleSpinning;
    self.progress.controlSize=NSControlSizeSmall;
    self.openButton=[NSButton buttonWithTitle:@"打开工作台" target:self action:@selector(openInBrowser:)];
    self.openButton.bezelStyle=NSBezelStyleRounded;self.openButton.keyEquivalent=@"\r";self.openButton.enabled=NO;
    self.openButton.bezelColor=title.textColor;
    self.openButton.toolTip=@"已打开时前置浏览器；网页已关闭时可从「文件」菜单重新打开网页。";
    NSButton *retry=[NSButton buttonWithTitle:@"重新检查" target:self action:@selector(reload:)];
    NSButton *folder=[NSButton buttonWithTitle:@"文章目录" target:self action:@selector(openWorkspace:)];
    NSStackView *buttons=[NSStackView stackViewWithViews:@[self.openButton,retry,folder]];buttons.spacing=12;
    NSTextField *hint=[NSTextField labelWithString:@"编辑与 PDF 预览将在浏览器中打开。"];
    hint.font=[NSFont systemFontOfSize:11];hint.textColor=[NSColor secondaryLabelColor];
    NSStackView *stack=[NSStackView stackViewWithViews:@[icon,title,self.status,self.address,self.progress,buttons,hint]];
    stack.orientation=NSUserInterfaceLayoutOrientationVertical;stack.spacing=14;stack.translatesAutoresizingMaskIntoConstraints=NO;
    [self.overlay addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[[stack.centerXAnchor constraintEqualToAnchor:self.overlay.centerXAnchor],[stack.centerYAnchor constraintEqualToAnchor:self.overlay.centerYAnchor]]];
    [self.window center];[self.window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];
    self.openAfterReady=YES;
    [self startWorkbench];
}
- (NSMenu *)menu:(NSString *)title on:(NSMenu *)main {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
    NSMenu *submenu = [[NSMenu alloc] initWithTitle:title];
    item.submenu = submenu;
    [main addItem:item];
    return submenu;
}
- (void)item:(NSMenu *)menu title:(NSString *)title action:(SEL)action key:(NSString *)key target:(id)target modifiers:(NSEventModifierFlags)modifiers {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
    item.target = target;
    item.keyEquivalentModifierMask = modifiers;
    [menu addItem:item];
}
- (void)buildMenus {
    NSMenu *main = [NSMenu new];
    NSMenu *application = [self menu:@"EchoPaper" on:main];
    [self item:application title:@"关于 EchoPaper" action:@selector(orderFrontStandardAboutPanel:) key:@"" target:NSApp modifiers:NSEventModifierFlagCommand];
    [application addItem:[NSMenuItem separatorItem]];
    [self item:application title:@"隐藏 EchoPaper" action:@selector(hide:) key:@"h" target:NSApp modifiers:NSEventModifierFlagCommand];
    [self item:application title:@"隐藏其他应用" action:@selector(hideOtherApplications:) key:@"h" target:NSApp modifiers:NSEventModifierFlagCommand | NSEventModifierFlagOption];
    [self item:application title:@"显示全部" action:@selector(unhideAllApplications:) key:@"" target:NSApp modifiers:NSEventModifierFlagCommand];
    [application addItem:[NSMenuItem separatorItem]];
    [self item:application title:@"退出 EchoPaper" action:@selector(terminate:) key:@"q" target:NSApp modifiers:NSEventModifierFlagCommand];
    NSMenu *file = [self menu:@"文件" on:main];
    [self item:file title:@"打开工作台" action:@selector(openInBrowser:) key:@"o" target:self modifiers:NSEventModifierFlagCommand | NSEventModifierFlagShift];
    [self item:file title:@"重新打开网页" action:@selector(reopenInBrowser:) key:@"" target:self modifiers:NSEventModifierFlagCommand];
    [self item:file title:@"打开文章工作目录" action:@selector(openWorkspace:) key:@"" target:self modifiers:NSEventModifierFlagCommand];
    [file addItem:[NSMenuItem separatorItem]];
    [self item:file title:@"关闭窗口" action:@selector(performClose:) key:@"w" target:nil modifiers:NSEventModifierFlagCommand];
    NSMenu *view = [self menu:@"显示" on:main];
    [self item:view title:@"重新检查服务" action:@selector(reload:) key:@"r" target:self modifiers:NSEventModifierFlagCommand];
    NSMenu *windows = [self menu:@"窗口" on:main];
    [self item:windows title:@"最小化" action:@selector(performMiniaturize:) key:@"m" target:nil modifiers:NSEventModifierFlagCommand];
    [self item:windows title:@"缩放" action:@selector(performZoom:) key:@"" target:nil modifiers:NSEventModifierFlagCommand];
    [windows addItem:[NSMenuItem separatorItem]];
    [self item:windows title:@"前置全部窗口" action:@selector(arrangeInFront:) key:@"" target:NSApp modifiers:NSEventModifierFlagCommand];
    NSApp.windowsMenu = windows;
    NSMenu *help = [self menu:@"帮助" on:main];
    [self item:help title:@"EchoPaper 使用说明" action:@selector(openReadme:) key:@"" target:self modifiers:NSEventModifierFlagCommand];
    [self item:help title:@"查看运行日志" action:@selector(openLogs:) key:@"" target:self modifiers:NSEventModifierFlagCommand];
    NSApp.mainMenu = main;
}
- (void)startWorkbench {
    if (self.startup.running || self.probing) return;
    self.progress.hidden=NO;self.openButton.enabled=NO;
    self.status.textColor=[NSColor labelColor];
    [self.progress startAnimation:nil];
    self.status.stringValue = @"正在启动本地论文工作台…";
    self.probing = YES;
    [self stage:@"health probe before startup"];
    [self probeExistingWorkbench:^(NSURL *found){
        self.probing = NO;
        if(found)[self showWorkbench:found];
        else [self prepareControllerStartup];
    }];
}
- (void)showWorkbench:(NSURL *)url {
    self.workbenchURL=url;self.status.stringValue=@"● 本地服务运行中";
    self.status.textColor=[NSColor colorWithRed:0.17 green:0.40 blue:0.30 alpha:1];
    self.address.stringValue=url.absoluteString;
    [self.progress stopAnimation:nil];self.progress.hidden=YES;self.openButton.enabled=YES;
    [self stage:@"service ready (checking alone does not open a browser)"];
    if(self.openAfterReady){BOOL force=self.forceBrowserOpen;self.openAfterReady=NO;self.forceBrowserOpen=NO;[self presentWorkbench:force];}
}
- (void)presentWorkbench:(BOOL)force {
    if(!self.workbenchURL || self.openingBrowser)return;
    NSURL *url=self.workbenchURL;
    NSUserDefaults *defaults=[NSUserDefaults standardUserDefaults];
    NSDictionary *sessions=[defaults dictionaryForKey:@"EchoPaperBrowserSessions"] ?: @{};
    NSDictionary *record=sessions[self.workspace.path];
    if(!force && [record isKindOfClass:[NSDictionary class]] && [record[@"url"] isEqual:url.absoluteString]){
        NSRunningApplication *browser=[NSRunningApplication runningApplicationWithProcessIdentifier:[record[@"pid"] intValue]];
        BOOL sameLaunch=browser && !browser.terminated && browser.launchDate && fabs(browser.launchDate.timeIntervalSince1970-[record[@"launch"] doubleValue])<1;
        if(sameLaunch && [browser.bundleIdentifier isEqual:record[@"bundle"]] && [browser activateWithOptions:NSApplicationActivateIgnoringOtherApps]){
            [self stage:@"existing browser activated without opening or reloading a tab"];
            return;
        }
    }
    self.openingBrowser=YES;
    NSWorkspaceOpenConfiguration *configuration=[NSWorkspaceOpenConfiguration configuration];
    configuration.activates=YES;configuration.createsNewApplicationInstance=NO;
    [[NSWorkspace sharedWorkspace] openURL:url configuration:configuration completionHandler:^(NSRunningApplication *browser,NSError *error){
        dispatch_async(dispatch_get_main_queue(),^{
            self.openingBrowser=NO;
            if(error || !browser){self.status.stringValue=@"服务已运行，请复制地址在浏览器打开";[self stage:@"browser could not be opened"];return;}
            NSMutableDictionary *updated=[([defaults dictionaryForKey:@"EchoPaperBrowserSessions"] ?: @{}) mutableCopy];
            updated[self.workspace.path]=@{@"url":url.absoluteString,@"pid":@(browser.processIdentifier),@"launch":@(browser.launchDate.timeIntervalSince1970),@"bundle":browser.bundleIdentifier ?: @""};
            [defaults setObject:updated forKey:@"EchoPaperBrowserSessions"];
            [self stage:force ? @"new browser tab explicitly requested" : @"browser opened for the first time in this browser session"];
        });
    }];
}
- (void)probeExistingWorkbench:(void (^)(NSURL *))completion {
    // Reuse the live service through HTTP first. This avoids touching protected
    // Desktop files when opening another window of an already-running workspace.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        configuration.timeoutIntervalForRequest = 0.7;
        configuration.timeoutIntervalForResource = 1;
        NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
        NSURL *found = nil;
        for(NSInteger port=4173;port<4204;port++){
            NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld",(long)port]];
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            __block BOOL matches = NO;
            NSURLSessionDataTask *task = [session dataTaskWithURL:[url URLByAppendingPathComponent:@"api/health"] completionHandler:^(NSData *data,NSURLResponse *response,NSError *error){
                if(data && !error){NSDictionary *value = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];matches = [value isKindOfClass:[NSDictionary class]] && [value[@"workspaceRoot"] isEqual:self.workspace.path] && [value[@"ok"] boolValue];}
                dispatch_semaphore_signal(done);
            }];
            [task resume];
            if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,1200*NSEC_PER_MSEC)) != 0)[task cancel];
            if(matches){found=url;break;}
        }
        [session invalidateAndCancel];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self stage:found ? @"health probe matched workspace" : @"health probe found no matching service"];
            completion(found);
        });
    });
}
- (void)prepareControllerStartup {
    if(!self.workspaceAccessURL){
        NSData *bookmark = [[NSUserDefaults standardUserDefaults] dataForKey:@"EchoPaperWorkspaceAccess"];
        if(bookmark){BOOL stale=NO;NSError *error=nil;NSURL *url=[NSURL URLByResolvingBookmarkData:bookmark options:NSURLBookmarkResolutionWithSecurityScope relativeToURL:nil bookmarkDataIsStale:&stale error:&error];if(url && [url.path isEqual:self.workspace.path]){self.workspaceAccessURL=url;[url startAccessingSecurityScopedResource];}}
    }
    if(self.workspaceAccessURL){[self beginControllerStartup];return;}
    // macOS grants access through the user's explicit folder choice. The app
    // never changes privacy settings or substitutes a different workspace.
    self.status.stringValue = @"首次启动服务，请允许访问文章工作目录";
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title=@"允许 EchoPaper 访问文章工作目录";
    panel.message=@"选择「文章修改」文件夹，以便 EchoPaper 读取稿件并启动本地编译服务。后续将复用这次选择。";
    panel.prompt=@"允许访问";panel.canChooseFiles=NO;panel.canChooseDirectories=YES;panel.allowsMultipleSelection=NO;
    panel.directoryURL=self.workspace;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response){
        NSURL *url=panel.URL;
        if(response != NSModalResponseOK){[self.progress stopAnimation:nil];self.status.stringValue=@"已取消启动。使用「重新检查」可重试。";return;}
        if(![url.path isEqual:self.workspace.path]){[self showStartupError:@"请选择应用对应的「文章修改」工作目录。若已移动目录，请先重新构建桌面应用以更新路径。"];return;}
        self.workspaceAccessURL=url;[url startAccessingSecurityScopedResource];
        [self stage:@"workspace selected through system folder picker"];
        NSData *bookmark=[url bookmarkDataWithOptions:NSURLBookmarkCreationWithSecurityScope includingResourceValuesForKeys:nil relativeToURL:nil error:NULL];
        if(bookmark)[[NSUserDefaults standardUserDefaults] setObject:bookmark forKey:@"EchoPaperWorkspaceAccess"];
        [self beginControllerStartup];
    }];
}
- (void)beginControllerStartup {
    self.status.stringValue=@"正在启动本地论文服务…";
    [self stage:@"controller startup requested"];
    NSURL *script = [self.workspace URLByAppendingPathComponent:@"_system/scripts/control.mjs"];
    NSMutableArray<NSString *> *candidates = [NSMutableArray array];
    NSString *configured = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"EchoPaperNodePath"];
    if (configured) [candidates addObject:configured];
    [candidates addObjectsFromArray:@[[NSHomeDirectory() stringByAppendingPathComponent:@".local/bin/node"],@"/opt/homebrew/bin/node",@"/usr/local/bin/node"]];
    if (![[NSFileManager defaultManager] fileExistsAtPath:script.path]) { [self showStartupError:[NSString stringWithFormat:@"找不到工作台启动脚本：\n%@\n\n请恢复工作目录，或重新运行 build-macos-app.sh 更新应用路径。",script.path]]; return; }
    NSString *node = nil;
    for (NSString *candidate in candidates) if ([[NSFileManager defaultManager] isExecutableFileAtPath:candidate]) {node = candidate; break;}
    if (!node) {[self showStartupError:@"找不到 Node.js，请检查本机安装后重试。"];return;}
    NSTask *task = [NSTask new];
    NSString *outputPath=[NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"EchoPaper-controller-%@.log",[NSUUID UUID].UUIDString]];
    [[NSFileManager defaultManager] createFileAtPath:outputPath contents:[NSData data] attributes:@{NSFilePosixPermissions:@0600}];
    NSFileHandle *output=[NSFileHandle fileHandleForWritingAtPath:outputPath];
    task.executableURL = [NSURL fileURLWithPath:node];
    task.arguments = @[script.path,@"start",@"--no-open"];
    // Node resolves the script's workspace from import.meta.url. Starting its
    // bootstrap in a protected Desktop cwd can block getcwd() before JS runs.
    task.currentDirectoryURL = [NSURL fileURLWithPath:NSHomeDirectory() isDirectory:YES];
    NSMutableDictionary *environment = [[NSProcessInfo processInfo].environment mutableCopy];
    environment[@"PATH"] = [NSString stringWithFormat:@"%@:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:%@",node.stringByDeletingLastPathComponent,environment[@"PATH"] ?: @""];
    task.environment = environment;
    task.standardOutput = output;
    task.standardError = output;
    self.startup = task;
    task.terminationHandler=^(NSTask *finished){
        [self stage:[NSString stringWithFormat:@"controller exited status=%d",finished.terminationStatus]];
        @try{[output closeFile];}@catch(NSException *error){}
        NSString *text=[NSString stringWithContentsOfFile:outputPath encoding:NSUTF8StringEncoding error:NULL] ?: @"";
        [[NSFileManager defaultManager] removeItemAtPath:outputPath error:NULL];
        dispatch_async(dispatch_get_main_queue(), ^{
            if(self.startup != finished){[self stage:@"controller completion ignored after cancellation"];return;}
            self.startup=nil;
            // Controller exit, not pipe EOF or localized stdout, drives readiness.
            [self probeExistingWorkbench:^(NSURL *found){
                if(found)[self showWorkbench:found];
                else [self showStartupError:text.length ? text : @"控制器已退出，但对应工作目录的服务未通过健康检查。请查看运行日志后重试。"];
            }];
        });
    };
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSError *failure = nil;
        if (![task launchAndReturnError:&failure]) { [self stage:[NSString stringWithFormat:@"controller launch failed: %@",failure.localizedDescription]];dispatch_async(dispatch_get_main_queue(), ^{self.startup = nil;[self showStartupError:failure.localizedDescription];});return; }
        [self stage:[NSString stringWithFormat:@"controller launched pid=%d",task.processIdentifier]];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,45*NSEC_PER_SEC),dispatch_get_main_queue(), ^{
            if(self.startup == task){
                [self stage:@"controller readiness timed out"];
                if(task.running)[task terminate];self.startup = nil;
                [self showStartupError:@"启动超过45秒，已停止等待。请检查是否有系统文件访问许可提示，然后重试。运行日志位于工作目录的 _system/runtime/。"];
            }
        });
    });
}
- (void)showStartupError:(NSString *)message {
    [self stage:[NSString stringWithFormat:@"startup error: %@",message]];
    [self.progress stopAnimation:nil];
    self.status.stringValue = @"工作台暂时无法启动";
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"EchoPaper 启动失败";
    alert.informativeText = message.length > 7000 ? [message substringFromIndex:message.length - 7000] : message;
    alert.alertStyle = NSAlertStyleWarning;
    [alert addButtonWithTitle:@"重试"];
    [alert addButtonWithTitle:@"查看日志目录"];
    [alert addButtonWithTitle:@"退出"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) { if (response == NSAlertFirstButtonReturn) [self startWorkbench];else if(response == NSAlertSecondButtonReturn) [self openLogs:nil];else [NSApp terminate:nil]; }];
}
- (void)reload:(id)sender {[self startWorkbench];}
- (void)openWorkspace:(id)sender {[[NSWorkspace sharedWorkspace] openURL:self.workspace];}
- (void)openReadme:(id)sender {[[NSWorkspace sharedWorkspace] openURL:[self.workspace URLByAppendingPathComponent:@"README.md"]];}
- (void)openLogs:(id)sender {[[NSWorkspace sharedWorkspace] openURL:[self.workspace URLByAppendingPathComponent:@"_system/runtime" isDirectory:YES]];}
- (void)openInBrowser:(id)sender {self.openAfterReady=YES;[self startWorkbench];}
- (void)reopenInBrowser:(id)sender {self.openAfterReady=YES;self.forceBrowserOpen=YES;[self startWorkbench];}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {return YES;}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {[self stage:@"app icon reopened: showing launcher only"];[self.window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];[self startWorkbench];return YES;}
- (void)applicationWillTerminate:(NSNotification *)notification {if(self.startup.running)[self.startup terminate];[self.workspaceAccessURL stopAccessingSecurityScopedResource];/* The shared local server remains available to other windows. */}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        static EchoPaperApp *delegate;
        delegate = [EchoPaperApp new];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
