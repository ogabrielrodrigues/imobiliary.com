import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ValidationError } from "../domain/errors.ts";
import { validateRegistration } from "../domain/user.ts";
import { FormApi } from "@tanstack/react-form";

import { blurThenChange, formErrors, submitForm, visibleError } from "./form.ts";

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
    assert.equal(
      formErrors(
        validateRegistration({
          email: "a@b.co",
          name: "Ana",
          password: "uma senha bem longa",
          organizationName: "Central",
          acceptedTerms: true,
        }),
      ),
      undefined,
    );
  });

  it("maps a domain validator's answer onto the fields", () => {
    assert.deepEqual(
      formErrors(
        validateRegistration({
          email: "",
          name: "",
          password: "",
          organizationName: "",
          acceptedTerms: false,
        }),
      ),
      {
        fields: {
          name: "Informe seu nome.",
          email: "Informe seu e-mail.",
          organization_name: "Informe o nome do escritório.",
          password: "Informe uma senha.",
          terms: "É preciso aceitar os termos.",
        },
      },
    );
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

describe("submitForm", () => {
  /**
   * The bug it exists for: an error computed while the form was incomplete and
   * never shown, then made obsolete by a change that did not validate. The
   * first submit used to stop there.
   */
  async function staleForm() {
    let submitted = 0;
    const form = new FormApi({
      defaultValues: { owners: [] as string[] },
      validationLogic: blurThenChange,
      validators: {
        onDynamic: ({ value }) =>
          formErrors(value.owners.length === 0 ? [{ field: "owners", message: "Informe ao menos um proprietário." }] : []),
      },
      onSubmit: () => {
        submitted++;
      },
    });
    form.mount();
    // Leaving another field validates the whole form while owners is empty.
    form.validate("blur");
    // The owner arrives without a validation: no field is showing an error.
    form.setFieldValue("owners", ["pessoa"], { dontValidate: true });
    return { form, submitted: () => submitted };
  }

  it("shows the problem it guards against", async () => {
    const { form, submitted } = await staleForm();
    await form.handleSubmit();
    assert.equal(submitted(), 0);
  });

  it("submits on the first attempt once the form is valid", async () => {
    const { form, submitted } = await staleForm();
    await submitForm(form);
    assert.equal(submitted(), 1);
  });
});
