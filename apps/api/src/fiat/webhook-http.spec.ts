import { publicWebhookAddress } from "./webhook-http";
describe("webhook destination policy", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.16.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"])("rejects %s", address => expect(publicWebhookAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", address => expect(publicWebhookAddress(address)).toBe(true));
});
