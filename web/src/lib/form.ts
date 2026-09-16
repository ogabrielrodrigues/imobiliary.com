/**
 * How every form here validates, on top of TanStack Form.
 *
 * The rules themselves are the domain's validators — the same functions the
 * server functions run — so a form never keeps a second copy of them. This
 * module only decides when they run and how their answer reaches the fields.
 */

import type { ValidationLogicFn } from "@tanstack/react-form";

import type { FieldError, ValidationError } from "../domain/errors.ts";

/**
 * When validation runs:
 *
 * - leaving a field validates it;
 * - while a field shows an error, every keystroke validates again, so the
 *   error goes the moment it is fixed;
 * - while no field shows an error, typing is not judged;
 * - submitting validates everything, and from then on every keystroke does.
 *
 * The validator is the form's `onDynamic`. It checks the whole form each time,
 * but only fields someone has left, or every field after a submit, display
 * what it found — see `visibleError`.
 */
export const blurThenChange: ValidationLogicFn = (props) => {
  const { event, form, validators } = props;
  const fn = event.async ? validators?.onDynamicAsync : validators?.onDynamic;

  const run = (should: boolean) =>
    props.runValidation({
      form,
      validators: should && fn !== undefined ? [{ fn, cause: "dynamic" }] : [],
    });

  switch (event.type) {
    case "blur":
    case "submit":
      return run(true);

    case "change": {
      if (form.state.submissionAttempts > 0) return run(true);
      // A form-level validator is called without the name of the field that
      // changed, so the question is whether any field is showing an error.
      // Checking the whole form then only changes what those fields show:
      // an untouched field's error stays hidden by `visibleError` either way.
      const metas: readonly (ShownFieldMeta | undefined)[] = Object.values(
        form.state.fieldMeta,
      );
      return run(metas.some((meta) => meta !== undefined && meta.isBlurred && meta.errors.length > 0));
    }

    default:
      return run(false);
  }
};

/**
 * A domain validator's answer, in the shape a form-level validator returns:
 * one message per field, the first recorded for it. `undefined` when valid.
 */
export function formErrors(
  problems: ValidationError | readonly FieldError[] | null,
): { fields: Record<string, string> } | undefined {
  const list = problems === null ? [] : "fields" in problems ? problems.fields : problems;
  if (list.length === 0) return undefined;

  const fields: Record<string, string> = {};
  for (const { field, message } of list) {
    fields[field] ??= message;
  }
  return { fields };
}

/**
 * Submits a form after validating it again with what it holds now.
 *
 * TanStack Form's handleSubmit gives up on a first attempt when the form
 * already holds an error, without validating again. With `blurThenChange` an
 * error can be computed and kept hidden: leaving an address field validates
 * the whole form while the owners list is still empty, and adding an owner
 * later does not validate, since no field was showing an error. The first
 * click on the submit button then met that stale error and did nothing but
 * reveal it. Validating for "submit" first replaces every stale error with the
 * current answer, so the first click submits whenever the form is valid.
 */
export async function submitForm(form: {
  validate: (cause: "submit") => unknown;
  handleSubmit: () => Promise<unknown>;
}): Promise<void> {
  await form.validate("submit");
  await form.handleSubmit();
}

/** The part of a field's state that decides whether its error is shown. */
export interface ShownFieldMeta {
  readonly isBlurred: boolean;
  readonly errors: readonly unknown[];
}

/**
 * The error to show under a field, if any.
 *
 * Only once the field has been left or the form submitted: an error that
 * appears while someone is still typing their first attempt is an accusation,
 * not help.
 */
export function visibleError(meta: ShownFieldMeta, submitted: boolean): string | undefined {
  if (!meta.isBlurred && !submitted) return undefined;
  return meta.errors.find((error): error is string => typeof error === "string");
}
