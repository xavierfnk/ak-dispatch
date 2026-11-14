export class DispatchValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("invalid calculation request");
    this.name = "DispatchValidationError";
    this.issues = issues;
  }
}

export class ProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
  }
}
