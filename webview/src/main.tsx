import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import '@xyflow/react/dist/base.css';
import './styles.css';
import './market.css';
import { App } from './App';
import { MarketplaceApp } from './marketplace/MarketplaceApp';
import { ActivityApp } from './activity/ActivityApp';

const container = document.getElementById('root');
if (container) {
  const page = container.dataset.page;
  createRoot(container).render(<StrictMode>{page === 'marketplace' ? <MarketplaceApp /> : page === 'activity' ? <ActivityApp /> : <App />}</StrictMode>);
}
