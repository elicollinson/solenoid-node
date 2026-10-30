import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { AppSettingsSchema } from './schema.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  parsedValue?: unknown;
}

type SectionValidator = (yamlString: string) => ValidationResult;

// Registry of section validators
const sectionValidators: Map<string, SectionValidator> = new Map();

/**
 * Validate YAML syntax only - used as fallback for unknown sections
 */
function validateYamlSyntax(yamlString: string): ValidationResult {
  try {
    const parsed = parseYaml(yamlString);
    return { isValid: true, errors: [], parsedValue: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid YAML syntax';
    return {
      isValid: false,
      errors: [{ path: '', message }],
    };
  }
}

/**
 * Create a validator from a Zod schema
 */
function createZodValidator(schema: z.ZodType): SectionValidator {
  return (yamlString: string): ValidationResult => {
    // First validate YAML syntax
    const syntaxResult = validateYamlSyntax(yamlString);
    if (!syntaxResult.isValid) {
      return syntaxResult;
    }

    // Then validate against schema
    const result = schema.safeParse(syntaxResult.parsedValue);
    if (result.success) {
      return { isValid: true, errors: [], parsedValue: result.data };
    }

    const errors: ValidationError[] = result.error.issues.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));

    return { isValid: false, errors };
  };
}

// One validator per top-level section of the settings schema
for (const [key, schema] of Object.entries(AppSettingsSchema.shape)) {
  sectionValidators.set(key, createZodValidator(schema));
}

/**
 * Main entry point - uses specific validator if registered, else just YAML parse
 */
export function validateSection(key: string, yamlString: string): ValidationResult {
  const validator = sectionValidators.get(key);
  if (validator) {
    return validator(yamlString);
  }
  // Fallback to YAML-only validation for unknown sections
  return validateYamlSyntax(yamlString);
}

/**
 * Check if a section has a registered validator
 */
export function hasValidator(key: string): boolean {
  return sectionValidators.has(key);
}

/**
 * Get list of all registered validator keys
 */
export function getRegisteredValidators(): string[] {
  return Array.from(sectionValidators.keys());
}
