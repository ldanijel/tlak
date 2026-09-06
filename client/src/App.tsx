import { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { syncIfStale } from './sync/sync.ts';
import { StoreProvider, useStore } from './store.tsx';
import { ToastProvider, Spinner } from './components/ui.tsx';
import { Nav } from './components/Nav.tsx';
import { LockGate } from './components/Lock.tsx';
import { HomePage } from './pages/Home.tsx';
import { NewMeasurementPage } from './pages/NewMeasurement.tsx';
import { PhotoPage } from './pages/Photo.tsx';
import { HistoryPage } from './pages/History.tsx';
import { MeasurementDetailPage } from './pages/MeasurementDetail.tsx';
import { AnalysisPage } from './pages/Analysis.tsx';
import { ReportPage } from './pages/Report.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { AccountPage } from './pages/Account.tsx';
import { TargetsPage } from './pages/Targets.tsx';
import { TherapyPage } from './pages/Therapy.tsx';
import { BackupPage } from './pages/Backup.tsx';
import { DevicesPage } from './pages/Devices.tsx';

function Shell() {
  const { ready } = useStore();
  const location = useLocation();
  useEffect(() => { syncIfStale(); }, [location.pathname]);
  if (!ready) return <div className="page"><Spinner text="Učitavanje podataka…" /></div>;
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/new" element={<NewMeasurementPage />} />
        <Route path="/new/photo" element={<PhotoPage mode="camera" />} />
        <Route path="/new/gallery" element={<PhotoPage mode="gallery" />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/measurement/:id" element={<MeasurementDetailPage />} />
        <Route path="/measurement/:id/edit" element={<NewMeasurementPage />} />
        <Route path="/analysis" element={<AnalysisPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/account" element={<AccountPage />} />
        <Route path="/settings/targets" element={<TargetsPage />} />
        <Route path="/settings/therapy" element={<TherapyPage />} />
        <Route path="/settings/devices" element={<DevicesPage />} />
        <Route path="/settings/backup" element={<BackupPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <Nav />
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <LockGate>
          <StoreProvider>
            <Shell />
          </StoreProvider>
        </LockGate>
      </ToastProvider>
    </BrowserRouter>
  );
}
