#import "ObjCSupport.h"

BOOL junmitRunCatchingException(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        return NO;
    }
}
