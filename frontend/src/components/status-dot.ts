import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("status-dot")
export class StatusDot extends LitElement {
  @property({ type: String })
  status = "waiting";

  private getStatusLabel(status: string): string {
    const key = status.toLowerCase();
    const labels: Record<string, string> = {
      waiting: "等待中",
      queued: "排队中",
      pending: "待处理",
      running: "运行中",
      active: "活跃",
      done: "已完成",
      completed: "已完成",
      recovered: "中断恢复",
      retry: "重试中",
      failed: "失败",
      error: "错误",
      cancelled: "已取消",
      skipped: "已跳过",
    };
    return labels[key] ?? status;
  }

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-ui, "Space Grotesk", sans-serif);
      font-size: 10px;
      color: var(--text-muted, #a1a1aa);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      line-height: 1;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--status-color, #6b7280);
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.2),
        0 0 0 4px color-mix(in srgb, var(--status-color, #6b7280), transparent 86%);
    }

    @keyframes pulse {
      0% {
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.2),
          0 0 0 2px color-mix(in srgb, var(--status-color, #6b7280), transparent 86%);
      }
      100% {
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.2),
          0 0 0 8px color-mix(in srgb, var(--status-color, #6b7280), transparent 100%);
      }
    }

    :host([status="running"]) .dot,
    :host([status="active"]) .dot {
      --status-color: var(--accent-ok, #22c55e);
      animation: pulse 1.2s ease-out infinite;
    }

    :host([status="done"]) .dot,
    :host([status="completed"]) .dot {
      --status-color: var(--accent-ok, #22c55e);
    }

    :host([status="recovered"]) .dot {
      --status-color: #38bdf8;
    }

    :host([status="retry"]) .dot,
    :host([status="pending"]) .dot,
    :host([status="queued"]) .dot {
      --status-color: var(--accent-warn, #f59e0b);
    }

    :host([status="failed"]) .dot,
    :host([status="error"]) .dot {
      --status-color: var(--accent-danger, #ef4444);
    }

    :host([status="cancelled"]) .dot,
    :host([status="skipped"]) .dot,
    :host([status="waiting"]) .dot {
      --status-color: #71717a;
    }
  `;

  render() {
    return html`<span class="dot"></span><span>${this.getStatusLabel(this.status)}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "status-dot": StatusDot;
  }
}
