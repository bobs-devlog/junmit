import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { logError } from "@/utils/logging";
import styles from "./ErrorBoundary.module.css";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  // 파일 로그에 기록 — 원격(Sentry)은 @sentry/browser가 자동 후킹하므로 별도 전송 불필요.
  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError("ErrorBoundary", `${error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div className={styles.errorBoundary}>
          <div className={styles.errorBoundaryIcon}>!</div>
          <div className={styles.errorBoundaryMsg}>
            {this.props.fallbackMessage || "예기치 않은 오류가 발생했습니다."}
          </div>
          <div className={styles.errorBoundaryDetail}>{this.state.error.message}</div>
          <button className="btn btn-secondary" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
