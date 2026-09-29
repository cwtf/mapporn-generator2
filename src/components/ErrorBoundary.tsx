import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onReset: () => void;
}

/** Keeps a bad map state (e.g. from the agent) from blanking the whole app. */
export class MapErrorBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="map-crash">
        <p>The map could not be drawn: {this.state.error.message}</p>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            this.props.onReset();
            this.setState({ error: undefined });
          }}
        >
          Reset map
        </button>
      </div>
    );
  }
}
