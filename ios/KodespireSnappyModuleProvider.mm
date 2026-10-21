#import "KodespireSnappyModuleProvider.h"

#import "KodespireSnappyModule.h"

@implementation KodespireSnappyModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::KodespireSnappyModule>(params.jsInvoker);
}

@end
