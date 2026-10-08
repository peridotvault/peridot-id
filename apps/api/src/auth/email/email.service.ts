import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 10_000;
const EMAIL_FROM = "no-reply@peridotvault.com";
const EMAIL_FROM_NAME = "PeridotID";

/**
 * Transactional email via the Brevo REST API (no SDK — plain fetch).
 * Auth-only sender; the sender address must be verified in the Brevo
 * dashboard or every call fails. Sender identity is static; only
 * BREVO_API_KEY is env.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  /** Send the 6-digit login code. Never logs the code itself. */
  async sendOtp(to: string, code: string): Promise<void> {
    const apiKey = this.config.get<string>("BREVO_API_KEY", "");

    if (!apiKey) {
      // Local dev without Brevo keys: surface the code in the server log so
      // the flow stays testable without burning quota. Never in production —
      // verify() refuses to issue sessions when the sender is unconfigured.
      if (this.config.get<string>("NODE_ENV", "development") === "production") {
        throw new ServiceUnavailableException("Email sign-in is not available right now — please try again later.");
      }
      this.logger.log(`email OTP for ${to} (dev fallback, Brevo not configured)`);
      return;
    }

    const htmlContent =
      `<p>Your PeridotID login code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>` +
      `<p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`;
    let res: Response;
    try {
      res = await fetch(BREVO_SEND_URL, {
        method: "POST",
        headers: { accept: "application/json", "api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          sender: { name: EMAIL_FROM_NAME, email: EMAIL_FROM },
          to: [{ email: to }],
          subject: "Your PeridotID login code",
          htmlContent,
          textContent: `Your PeridotID login code is: ${code}\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`brevo send failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException("Couldn't send the code — please try again.");
    }
    if (res.status !== 201) {
      const body = await res.text().catch(() => "");
      this.logger.error(`brevo send rejected: ${res.status} ${body.slice(0, 200)}`);
      throw new ServiceUnavailableException("Couldn't send the code — please try again.");
    }
  }

  /** True when the Brevo sender is configured (verify() issues sessions only then). */
  isConfigured(): boolean {
    return !!this.config.get<string>("BREVO_API_KEY", "");
  }
}
