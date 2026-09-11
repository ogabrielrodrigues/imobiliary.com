import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ValidationError } from "../domain/errors.ts";
import { validateLogin } from "../domain/user.ts";
import { blurThenChange, formErrors, visibleError } from "./form.ts";

type LogicProps = Parameters<typeof blurThenChange>[0];

/** Runs the logic against a stand-in form and reports whether it validated. */
function validates(
  type: LogicProps["event"]["type"],
  state: { submissionAttempts?: number; isBlurred?: boolean; errors?: unknown[] } = {},
): boolean {
  let ran = false;
  const form = {
    state: {
      submissionAttempts: state.submissionAttempts ?? 0,
      fieldMeta: {
        email: { isBlurred: state.isBlurred ?? false, errors: state.errors ?? [] },
        password: { isBlurred: false, errors: [] },
      },
    },
  };

  blurThenChange({
    form: form as unknown as LogicProps["form"],
    validators: { onDynamic: () => undefined },
    // No fieldName: a form-level validator is called without one, which is
    // exactly what the first version of this logic got wrong.
    event: { type, async: false },
    runValidation: ({ validators }) => {
      ran = validators.length > 0;
    },
  });
  return ran;
}

describe("blurThenChange", () => {
  it("validates when a field is left", () => {
    assert.equal(validates("blur"), true);
  });

  it("does not judge a first attempt while it is typed", () => {
    assert.equal(validates("change"), false);
    assert.equal(validates("change", { isBlurred: true }), false);
  });

  it("revalidates on every keystroke while the field shows an error", () => {
    assert.equal(validates("change", { isBlurred: true, errors: ["Informe seu e-mail."] }), true);
  });

  it("validates everything on submit, and every keystroke after it", () => {
    assert.equal(validates("submit"), true);
    assert.equal(validates("change", { submissionAttempts: 1 }), true);
  });

  it("does nothing on mount", () => {
    assert.equal(validates("mount"), false);
  });
});

describe("formErrors", () => {
  it("is undefined for a valid form", () => {
    assert.equal(formErrors(null), undefined);
    assert.equal(formErrors(validateLogin({ email: "a@b.co", password: "x" })), undefined);
  });

  it("maps a domain validator's answer onto the fields", () => {
    assert.deepEqual(formErrors(validateLogin({ email: "", password: "" })), {
      fields: { email: "Informe seu e-mail.", password: "Informe sua senha." },
    });
  });

  it("keeps the first message when a field has several", () => {
    const error = new ValidationError([
      { field: "file", message: "primeira" },
      { field: "file", message: "segunda" },
    ]);
    assert.deepEqual(formErrors(error), { fields: { file: "primeira" } });
  });
});

describe("visibleError", () => {
  const invalid = { isBlurred: false, errors: [undefined, "Informe seu e-mail."] };

  it("hides an error until the field is left", () => {
    assert.equal(visibleError(invalid, false), undefined);
    assert.equal(visibleError({ ...invalid, isBlurred: true }, false), "Informe seu e-mail.");
  });

  it("shows every error once the form was submitted", () => {
    assert.equal(visibleError(invalid, true), "Informe seu e-mail.");
  });
});
