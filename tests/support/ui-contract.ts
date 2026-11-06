import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

export interface SelectorDefinition {
  testId?: string;
  testIdPattern?: string;
  role?: string;
  name?: string;
  namePattern?: string;
}

export interface UiInteractionContract {
  version: string;
  name: string;
  testIdAttribute: string;
  baseUrl: { env: string; default: string };
  routes: Record<string, string>;
  selectors: Record<string, SelectorDefinition>;
  requiredTestIds: string[];
  taskLanes: Record<string, string[]>;
  uiStates: Record<string, string[]>;
  flows: Record<string, string[]>;
  testApi: {
    baseUrl: { env: string; default: string };
    enabledWhen: string;
    endpoints: Record<string, { method: string; path: string; body?: Record<string, unknown> }>;
  };
  deterministicSeed: {
    workspaceId: string;
    projectId: string;
    agents: string[];
    tasks: string[];
    completedExecutionId: string;
  };
}

function loadContract(): UiInteractionContract {
  const path = resolve(process.cwd(), 'tests/contract/ui-interaction.contract.json');
  return JSON.parse(readFileSync(path, 'utf8')) as UiInteractionContract;
}

export const uiContract = loadContract();

const missingRequired = uiContract.requiredTestIds.filter(
  (testId) =>
    !Object.values(uiContract.selectors).some(
      (definition) => definition.testId === testId || definition.testIdPattern === testId,
    ),
);

if (missingRequired.length > 0) {
  throw new Error(
    `UI interaction contract is missing selector definitions for: ${missingRequired.join(', ')}`,
  );
}

export function selector(key: string): SelectorDefinition {
  const definition = uiContract.selectors[key];
  if (!definition) {
    throw new Error(`Unknown UI interaction selector: ${key}`);
  }
  return definition;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export function resolveTestId(key: string, values: Record<string, string> = {}): string {
  const definition = selector(key);
  const template = definition.testId ?? definition.testIdPattern;
  if (!template) {
    throw new Error(`Selector "${key}" does not define a test id.`);
  }
  return interpolate(template, values);
}

export function byTestId(page: Page | Locator, key: string, values: Record<string, string> = {}): Locator {
  return page.getByTestId(resolveTestId(key, values));
}

export function bySelector(page: Page | Locator, key: string, values: Record<string, string> = {}): Locator {
  const definition = selector(key);
  const name = definition.namePattern
    ? interpolate(definition.namePattern, values)
    : definition.name;
  if (definition.role && name) {
    return page.getByRole(definition.role as Parameters<Page['getByRole']>[0], { name });
  }
  if (definition.role) {
    return page.getByRole(definition.role as Parameters<Page['getByRole']>[0]);
  }
  return byTestId(page, key, values);
}

export function route(key: string, values: Record<string, string> = {}): string {
  const template = uiContract.routes[key];
  if (!template) {
    throw new Error(`Unknown route: ${key}`);
  }
  return interpolate(template, values);
}
