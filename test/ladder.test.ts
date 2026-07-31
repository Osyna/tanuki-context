// F5: ladder hedges + filename gate.
import { describe, expect, test } from "bun:test";
import { compressText } from "../src/ladder.ts";
import { isSensitivePath } from "../src/gate.ts";

describe("HEDGES at L2", () => {
  test("H1: it might be worth considering that -> removed", () => {
    const input = "It might be worth considering that this is a test.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("This is a test.");
  });

  test("H2: it is worth noting that -> removed", () => {
    const input = "It is worth noting that the value is zero.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("The value is zero.");
  });

  test("H3: keep in mind that -> removed", () => {
    const input = "Please keep in mind that this may fail.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("This may fail.");
  });

  test("H4: it goes without saying that -> removed", () => {
    const input = "It goes without saying that we need this.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("We need this.");
  });

  test("H5: needless to say -> removed (with comma)", () => {
    const input = "Needless to say, the fix works.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("The fix works.");
  });

  test("H5: needless to say -> removed (without comma)", () => {
    const input = "Needless to say the fix works.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("The fix works.");
  });

  test("H6: in my opinion -> removed (with comma)", () => {
    const input = "In my opinion, this is correct.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("This is correct.");
  });

  test("H7: as far as I know -> removed (with comma)", () => {
    const input = "As far as I can tell, it works.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("It works.");
  });

  test("H8: at the end of the day -> removed (with comma)", () => {
    const input = "At the end of the day, we ship.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("We ship.");
  });

  test("H9: make sure to -> removed", () => {
    const input = "Make sure to check the logs.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("Check the logs.");
  });

  test("H10: you should ensure that -> ensure", () => {
    const input = "You should ensure that it is safe.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("Ensure it is safe.");
  });

  test("H11: I'd recommend using -> use", () => {
    const input = "I'd recommend using the new API.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("Use the new API.");
  });

  test("H11: I would recommend trying -> use", () => {
    const input = "I would recommend trying the beta.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("Use the beta.");
  });

  test("H12: I'd recommend -> removed", () => {
    const input = "I'd recommend a different approach.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("A different approach.");
  });

  test("H13: to be honest -> removed (with comma)", () => {
    const input = "To be honest, that seems fine.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("That seems fine.");
  });

  test("H14: it turns out -> removed", () => {
    const input = "It turns out that the bug is fixed.";
    const out = compressText(input, 2);
    expect(out.compressed).toBe("The bug is fixed.");
  });

  test("L1 leaves hedges alone", () => {
    const input = "It is worth noting that this is a test.";
    const out = compressText(input, 1);
    expect(out.compressed).toBe(input);
  });

  test("protected line bypasses hedges", () => {
    // indented line = protected
    const input = "  it is worth noting that this is code";
    const out = compressText(input, 2);
    expect(out.compressed).toBe(input);
  });
});

describe("filename gate", () => {
  test(".env variants refuse", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("/home/user/.env.test")).toBe(true);
  });

  test("SSH keys refuse", () => {
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_rsa.pub")).toBe(true);
    expect(isSensitivePath("id_ed25519")).toBe(true);
    expect(isSensitivePath("/home/user/.ssh/id_ecdsa")).toBe(true);
  });

  test("credential substring in basename refuses", () => {
    expect(isSensitivePath("prod-credentials.json")).toBe(true);
    expect(isSensitivePath("api-secret.txt")).toBe(true);
  });

  test("path component .aws/.ssh/.gnupg/.kube refuses", () => {
    expect(isSensitivePath("/home/user/.aws/config")).toBe(true);
    expect(isSensitivePath("/home/user/.ssh/known_hosts")).toBe(true);
    expect(isSensitivePath("/etc/.gnupg/gpg.conf")).toBe(true);
    expect(isSensitivePath("/root/.kube/config")).toBe(true);
  });

  test("overcaution: secretary matches credential substring", () => {
    // accepted overcaution per contract
    expect(isSensitivePath("secretary-notes.md")).toBe(true);
  });

  test(".envrc does NOT match pattern (passes)", () => {
    // .envrc does not match ^\.env(\..+)?$ (no dot after env)
    expect(isSensitivePath(".envrc")).toBe(false);
  });

  test("envelope.txt passes", () => {
    expect(isSensitivePath("envelope.txt")).toBe(false);
  });

  test("other common files pass", () => {
    expect(isSensitivePath("README.md")).toBe(false);
    expect(isSensitivePath("src/main.ts")).toBe(false);
    expect(isSensitivePath("/var/log/app.log")).toBe(false);
  });

  test("gate override: --allow-sensitive bypasses check", () => {
    // The CLI check: if (!argv.includes("--allow-sensitive") && isSensitivePath(file))
    // This test verifies the predicate returns true, and the flag would bypass it.
    expect(isSensitivePath(".env")).toBe(true);
    // With --allow-sensitive in argv, the condition becomes false and no fatal.
  });
});
