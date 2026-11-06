import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentDetailDto, AgentListQuery, AgentStatus } from '@raft-lite/contracts';
import { AGENT_STATUS_LABELS, AGENT_STATUSES } from '@raft-lite/contracts';
import { Plus, Search, X } from 'lucide-react';
import { useAgents, useComputers } from '../hooks/use-raft-data';
import { api, ApiError } from '../services/api';
import { queryKeys } from '../services/query-keys';
import { useToast } from '../providers/toast-provider';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/feedback';
import { Input, Select } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { AgentCard } from '../features/agents/agent-card';
import { AgentDetailDrawer } from '../features/agents/agent-detail-drawer';
import { AgentFormDialog, type AgentFormSubmission } from '../features/agents/agent-form-dialog';

export function AgentsPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAgentId = searchParams.get('agent');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AgentStatus | ''>('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDetailDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentDetailDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filters: AgentListQuery = useMemo(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(status ? { status } : {}),
      limit: 100,
    }),
    [search, status],
  );
  const agentsQuery = useAgents(filters);
  const computersQuery = useComputers();
  const agents = agentsQuery.data?.items ?? [];
  const hasFilters = Boolean(search.trim() || status);

  function setSelectedAgent(agentId: string | null): void {
    const next = new URLSearchParams(searchParams);
    if (agentId) {
      next.set('agent', agentId);
    } else {
      next.delete('agent');
    }
    setSearchParams(next, { replace: true });
  }

  function invalidateAgents(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    void queryClient.invalidateQueries({ queryKey: ['activities'] });
  }

  function openCreate(): void {
    setEditingAgent(null);
    setFormOpen(true);
  }

  function openEdit(agent: AgentDetailDto): void {
    setSelectedAgent(null);
    setEditingAgent(agent);
    setFormOpen(true);
  }

  function openDelete(agent: AgentDetailDto): void {
    setSelectedAgent(null);
    setDeleteTarget(agent);
  }

  async function handleFormSubmit(values: AgentFormSubmission): Promise<void> {
    if (editingAgent) {
      const updated = await api.updateAgent(editingAgent.id, {
        name: values.name,
        role: values.role,
        description: values.description,
        runtime: values.runtime,
        computerId: values.computerId,
        status: values.status,
      });
      invalidateAgents();
      toast({
        title: 'Agent updated',
        description: `${updated.name} now targets the ${updated.runtime} runtime.`,
        variant: 'success',
      });
      setSelectedAgent(updated.id);
    } else {
      const created = await api.createAgent({
        name: values.name,
        role: values.role,
        description: values.description,
        runtime: values.runtime,
        computerId: values.computerId,
      });
      invalidateAgents();
      toast({
        title: 'Agent created',
        description: `${created.name} is ready in the workspace.`,
        variant: 'success',
      });
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteAgent(deleteTarget.id);
      setDeleteTarget(null);
      setSelectedAgent(null);
      invalidateAgents();
      toast({
        title: 'Agent deleted',
        description: `${deleteTarget.name} was removed from the workspace.`,
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: 'Agent could not be deleted',
        description: error instanceof ApiError ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      setDeleting(false);
    }
  }

  function clearFilters(): void {
    setSearch('');
    setStatus('');
  }

  return (
    <div data-testid="agents-page">
      <PageHeader
        eyebrow="Workspace"
        title="Agents"
        description="Manage the AI workers that claim, execute, and validate work in this workspace."
        testId="agents-header"
        actions={
          <Button variant="primary" onClick={openCreate} data-testid="agent-create-button">
            <Plus size={14} aria-hidden="true" />
            New agent
          </Button>
        }
      />

      <div className="panel mb-4 flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-[340px]">
          <label htmlFor="agent-search" className="sr-only">
            Search agents
          </label>
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            id="agent-search"
            type="search"
            data-testid="agent-search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search agents by name, role, or description"
            className="pl-8"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="agent-status-filter" className="text-[11px] font-medium text-muted">
            Status
          </label>
          <Select
            id="agent-status-filter"
            data-testid="agent-status-filter"
            value={status}
            onChange={(event) => setStatus(event.target.value as AgentStatus | '')}
            className="w-[132px]"
          >
            <option value="">All statuses</option>
            {AGENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {AGENT_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              data-testid="agent-clear-filters-button"
            >
              <X size={12} aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </div>
        <div
          className="ml-auto hidden text-[10.5px] text-faint sm:block"
          data-testid="agents-count"
        >
          {agentsQuery.data ? `${agentsQuery.data.total} total` : ''}
        </div>
      </div>

      {agentsQuery.isLoading ? (
        <div
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading agents"
          data-testid="agents-loading"
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-[206px] rounded-2xl" />
          ))}
        </div>
      ) : agentsQuery.isError ? (
        <ErrorState
          title="Agents could not be loaded"
          description={
            agentsQuery.error instanceof Error
              ? agentsQuery.error.message
              : 'The agent list request failed.'
          }
          onRetry={() => void agentsQuery.refetch()}
          testId="agents-error"
          retryTestId="agents-retry-button"
        />
      ) : agents.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title="No agents match those filters"
            description="Try a different search or reset the status filter."
            testId="agents-filter-empty"
            action={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="Build your agent roster"
            description="Create the first agent and give it a role in this workspace."
            testId="agents-empty"
            action={
              <Button
                variant="primary"
                onClick={openCreate}
                data-testid="agents-empty-create-button"
              >
                <Plus size={14} aria-hidden="true" />
                Create agent
              </Button>
            }
          />
        )
      ) : (
        <div
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          data-testid="agent-list"
          role="list"
          aria-label="Agent list"
        >
          {agents.map((agent) => (
            <div key={agent.id} role="listitem">
              <AgentCard agent={agent} onOpen={setSelectedAgent} />
            </div>
          ))}
        </div>
      )}

      <AgentDetailDrawer
        agentId={selectedAgentId}
        onOpenChange={(open) => {
          if (!open) setSelectedAgent(null);
        }}
        onEdit={openEdit}
        onDelete={openDelete}
      />

      <AgentFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingAgent(null);
        }}
        mode={editingAgent ? 'edit' : 'create'}
        initial={editingAgent}
        computers={computersQuery.data?.items ?? []}
        onSubmit={handleFormSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget?.name ?? 'agent'}?`}
        description="The agent will be removed from the workspace. Tasks assigned to this agent will become unassigned, and execution history connected to it will be removed."
        confirmLabel="Delete agent"
        onConfirm={() => void handleDelete()}
        pending={deleting}
        danger
        testId="agent-delete-dialog"
        confirmTestId="agent-delete-confirm-button"
        cancelTestId="agent-delete-cancel-button"
      />
    </div>
  );
}
