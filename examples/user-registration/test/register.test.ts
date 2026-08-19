import assert from "node:assert/strict";
import test from "node:test";
import { registerUser } from "../src/register.js";

test("normalizes the email and display name", () => {
  const user = registerUser({
    email: "  DEV@EXAMPLE.COM ",
    password: "not-validated-yet",
    displayName: "  Ada  ",
  });

  assert.match(user.id, /^usr_/);
  assert.equal(user.email, "dev@example.com");
  assert.equal(user.displayName, "Ada");
});

