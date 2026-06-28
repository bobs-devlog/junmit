// Swift는 ObjC NSException을 잡지 못한다(do/catch·try?는 Swift Error만 처리). AVAudioEngine의
// connect/prepare는 디바이스 전환 등 변동 상태에서 NSException을 던질 수 있어, 그대로 두면 앱이 abort된다.
// 이 얇은 @try/@catch 션트로 그 예외를 Bool 실패로 바꿔 Swift가 안전하게 강등 처리하게 한다.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// block을 실행하고, ObjC NSException이 발생하면 NO를 반환한다(reason은 무시 — 호출부는 성공 여부만 필요).
BOOL junmitRunCatchingException(void (NS_NOESCAPE ^block)(void));

NS_ASSUME_NONNULL_END
