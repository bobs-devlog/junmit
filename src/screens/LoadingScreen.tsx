import styles from "@/App.module.css";

// 앱 부트 직후 init useEffect가 끝날 때까지 잠깐 노출되는 fullscreen 화면.
export default function LoadingScreen() {
  return (
    <div className={styles.app}>
      <div className={styles.appLoading}>초기화 중...</div>
    </div>
  );
}
