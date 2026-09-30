import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { RouterProvider, Toast, VerticalNavigation } from '@capra/core';
import { Book, Cog, HistoryOutlined, HomeOutlined } from '@capra/icons';
import { useAppData } from './api';
import Overview from './pages/Overview';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import Documentation from './pages/Documentation';

function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const app = useAppData();
  const section = pathname.split('/')[1] ?? '';

  return (
    <RouterProvider navigate={(path: string) => navigate(path)}>
      <Toast.Provider />
      <div className="app-shell">
        <div className="app-nav">
          <VerticalNavigation aria-label="Chat Firewall navigation">
            <VerticalNavigation.ItemList>
              <VerticalNavigation.Item
                label="Overview"
                icon={<HomeOutlined />}
                isActive={section === ''}
                onClick={() => navigate('/')}
              />
              <VerticalNavigation.Item
                label="Activity"
                icon={<HistoryOutlined />}
                isActive={section === 'activity'}
                onClick={() => navigate('/activity')}
              />
            </VerticalNavigation.ItemList>
            <VerticalNavigation.Footer>
              <VerticalNavigation.Item
                label="Settings"
                icon={<Cog />}
                isActive={section === 'settings'}
                onClick={() => navigate('/settings')}
              />
              <VerticalNavigation.Item
                label="Documentation"
                icon={<Book />}
                isActive={section === 'docs'}
                onClick={() => navigate('/docs')}
              />
            </VerticalNavigation.Footer>
          </VerticalNavigation>
        </div>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Overview {...app} />} />
            <Route path="/activity" element={<Activity {...app} />} />
            <Route path="/settings" element={<Navigate to="/settings/device" replace />} />
            <Route path="/settings/:tab" element={<Settings {...app} />} />
            <Route path="/docs" element={<Documentation />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </RouterProvider>
  );
}

export default App;
