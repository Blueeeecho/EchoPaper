#import <AppKit/AppKit.h>
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if(argc != 2)return 1;
        NSURL *output = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES];
        [[NSFileManager defaultManager] createDirectoryAtURL:output withIntermediateDirectories:YES attributes:nil error:NULL];
        NSColor *navy = [NSColor colorWithRed:78.0/255 green:95.0/255 blue:135.0/255 alpha:1];
        NSArray *names = @[@"icon_16x16.png",@"icon_16x16@2x.png",@"icon_32x32.png",@"icon_32x32@2x.png",@"icon_128x128.png",@"icon_128x128@2x.png",@"icon_256x256.png",@"icon_256x256@2x.png",@"icon_512x512.png",@"icon_512x512@2x.png"];
        NSArray *sizes = @[@16,@32,@32,@64,@128,@256,@256,@512,@512,@1024];
        for(NSUInteger index=0;index<names.count;index++){
            NSInteger size = [sizes[index] integerValue];
            NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:size pixelsHigh:size bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
            [NSGraphicsContext saveGraphicsState];
            [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
            NSAffineTransform *transform = [NSAffineTransform transform];[transform scaleBy:(CGFloat)size/1024];[transform concat];
            [navy setFill];[[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(40,40,944,944) xRadius:210 yRadius:210] fill];
            NSBezierPath *page = [NSBezierPath bezierPath];[page moveToPoint:NSMakePoint(278,188)];[page lineToPoint:NSMakePoint(746,188)];[page lineToPoint:NSMakePoint(746,680)];[page lineToPoint:NSMakePoint(596,836)];[page lineToPoint:NSMakePoint(278,836)];[page closePath];[[NSColor whiteColor] setFill];[page fill];
            NSBezierPath *fold = [NSBezierPath bezierPath];[fold moveToPoint:NSMakePoint(596,836)];[fold lineToPoint:NSMakePoint(596,680)];[fold lineToPoint:NSMakePoint(746,680)];[fold closePath];[[NSColor colorWithRed:0.81 green:0.85 blue:0.93 alpha:1] setFill];[fold fill];
            [[navy colorWithAlphaComponent:0.5] setFill];
            for(NSNumber *number in @[@620,@564,@508]){CGFloat y = number.doubleValue;[[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(344,y,y==508?226:302,17) xRadius:8 yRadius:8] fill];}
            [@"EP" drawAtPoint:NSMakePoint(342,264) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:136 weight:NSFontWeightSemibold],NSForegroundColorAttributeName:navy}];
            [NSGraphicsContext restoreGraphicsState];
            NSData *data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            if(![data writeToURL:[output URLByAppendingPathComponent:names[index]] atomically:YES])return 2;
        }
    }
    return 0;
}
