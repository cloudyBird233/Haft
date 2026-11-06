import type { ReactElement } from 'react';

export {};

declare global {
  namespace JSX {
    type Element = ReactElement;
  }
}
