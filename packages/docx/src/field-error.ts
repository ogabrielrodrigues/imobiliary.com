/**
 * One field-level problem, named exactly as an API names it.
 *
 * The block source reports what is wrong with a stored tree in the same shape
 * the platforms' own validation errors carry, so a caller can hand it to a form
 * without translating. It is declared here rather than imported so this package
 * depends on neither platform.
 */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}
