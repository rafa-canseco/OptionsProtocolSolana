import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";

describe("b1nary-options", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  describe("address_book", () => {
    it("initializes registry", async () => {
      // TODO: load IDL + initialize registry PDA
      assert.ok(true, "stub test");
    });
  });

  describe("controller", () => {
    it("opens a vault", async () => {
      assert.ok(true, "stub test");
    });
  });

  describe("margin_pool", () => {
    it("initializes pool", async () => {
      assert.ok(true, "stub test");
    });
  });

  describe("otoken_factory", () => {
    it("creates an otoken", async () => {
      assert.ok(true, "stub test");
    });
  });

  describe("oracle", () => {
    it("initializes oracle config", async () => {
      assert.ok(true, "stub test");
    });
  });

  describe("whitelist", () => {
    it("whitelists an underlying", async () => {
      assert.ok(true, "stub test");
    });
  });

  describe("batch_settler", () => {
    it("initializes settler config", async () => {
      assert.ok(true, "stub test");
    });
  });
});
