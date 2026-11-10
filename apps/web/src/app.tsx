import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/app-shell';
import { AgentsPage } from './pages/agents-page';
import { DashboardPage } from './pages/dashboard-page';
import { ExecutionPage } from './pages/execution-page';
import { NotFoundPage } from './pages/not-found-page';
import { ProjectsPage } from './pages/projects-page';
import { TasksPage } from './pages/tasks-page';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="executions/:id" element={<ExecutionPage />} />
        <Route path="dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
