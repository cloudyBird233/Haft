import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../components/error-boundary';

function BrokenView(): JSX.Element {
  throw new Error('Synthetic render failure');
}

describe('ErrorBoundary', () => {
  it('renders a recoverable fallback instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BrokenView />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('app-error-boundary')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByTestId('app-error-reload-button')).toHaveTextContent('Reload application');
  });
});
