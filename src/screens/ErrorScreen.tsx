import styles from "@/App.module.css";

// 앱 부트 실패 시 fullscreen 안내 화면. AppShell init useEffect의 catch 분기에서 navigate.
export default function ErrorScreen() {
  return (
    <div className={styles.app}>
      <div className={styles.appError}>
        <h1 className="setup-title">Junmit</h1>
        <div className="error-msg">앱 초기화에 실패했습니다.</div>
        <p className="setup-desc">
          앱을 재시작해주세요. 문제가 계속되면 시스템 설정에서 마이크·캘린더 권한을 확인하거나
          데이터 디렉토리(<code>~/Library/Application Support/app.junmit/</code>)를 정리한 뒤 다시
          실행해주세요.
        </p>
      </div>
    </div>
  );
}
