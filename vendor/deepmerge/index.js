'use strict';
// Stand-in for deepmerge, used only by @inkjs/ui's extendTheme. Replace with
// the real package once it ships a fix for GHSA-gcqx-w48m-w2h4.

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isMergeable(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return Array.isArray(value) || proto === Object.prototype || proto === null;
}

function clone(value) {
  return isMergeable(value) ? deepmerge(Array.isArray(value) ? [] : {}, value) : value;
}

function deepmerge(target, source) {
  if (Array.isArray(source)) {
    return Array.isArray(target) ? [...target, ...source].map(clone) : source.map(clone);
  }
  if (!isMergeable(source)) return source;
  const result = {};
  if (isMergeable(target) && !Array.isArray(target)) {
    for (const key of Object.keys(target)) {
      if (!UNSAFE_KEYS.has(key)) result[key] = clone(target[key]);
    }
  }
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    result[key] =
      Object.hasOwn(result, key) && isMergeable(source[key])
        ? deepmerge(result[key], source[key])
        : clone(source[key]);
  }
  return result;
}

deepmerge.all = function all(objects) {
  if (!Array.isArray(objects)) throw new Error('first argument should be an array');
  return objects.reduce((merged, next) => deepmerge(merged, next), {});
};

module.exports = deepmerge;
