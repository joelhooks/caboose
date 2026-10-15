export const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Synthetic fixture is missing a required entry");
  }

  return value;
};
