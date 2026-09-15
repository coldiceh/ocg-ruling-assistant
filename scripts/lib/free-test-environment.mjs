// Free tests may pass explicit provider fixtures to individual functions, but
// the runner process must not pass real Relay transport settings to children.
export const FREE_TEST_INHERITED_ENV_NAMES = Object.freeze([
  "RELAY_API_KEY",
  "RELAY_BASE_URL",
]);

export function isolateFreeTestEnvironment(environment = globalThis.process?.env) {
  if (!environment || typeof environment !== "object") return environment;
  for (const name of FREE_TEST_INHERITED_ENV_NAMES) delete environment[name];
  return environment;
}
