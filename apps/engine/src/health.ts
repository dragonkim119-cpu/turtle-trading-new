import type { Repo } from "@turtle/db";
import { fmtEngineAlert, type TelegramSender } from "./telegram.js";

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // max one engine alert per hour

export class Health {
  private apiFailures = 0;
  private telegramFailures = 0;
  private lastAlertAt = 0;

  constructor(
    private repo: Repo,
    private telegram: TelegramSender,
    private threshold = 5,
  ) {}

  apiOk(): void {
    this.apiFailures = 0;
    this.repo.setState("health", JSON.stringify({ status: "ok", at: Date.now() }));
  }

  async apiFail(detail: string): Promise<void> {
    this.apiFailures++;
    this.repo.setState(
      "health",
      JSON.stringify({ status: "degraded", failures: this.apiFailures, detail, at: Date.now() }),
    );
    if (this.apiFailures >= this.threshold && Date.now() - this.lastAlertAt > ALERT_COOLDOWN_MS) {
      this.lastAlertAt = Date.now();
      await this.telegram.send(
        fmtEngineAlert(`바이낸스 API ${this.apiFailures}회 연속 실패\n${detail}`),
      );
    }
  }

  telegramFail(): void {
    this.telegramFailures++;
    this.repo.setState(
      "health",
      JSON.stringify({ status: "telegram_degraded", failures: this.telegramFailures, at: Date.now() }),
    );
  }
}
