// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import fixture from "./demo-fixture.json";
import { App } from "../src/App";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

let tasks: any[] = [];
let errors: ReturnType<typeof vi.spyOn>;
let posts: { url: string; body: any }[] = [];

beforeEach(() => {
  tasks = [];
  posts = [];
  FakeEventSource.instances = [];
  localStorage.clear();
  // some browsers return a value here; effects must never leak it as a cleanup function
  Element.prototype.scrollIntoView = vi.fn(() => "not-a-function") as any;
  vi.spyOn(Storage.prototype, "setItem");
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { json: async () => ({}) };
      }
      return { json: async () => tasks };
    }),
  );
});
afterEach(() => {
  cleanup(); // unmounting is what used to blow up
  expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([]);
  vi.restoreAllMocks();
});

const stream = () => FakeEventSource.instances[0];

test("renders the welcome screen and offers a demo", async () => {
  render(<App />);
  expect(screen.getByText(/What should I work on/)).toBeTruthy();
  fireEvent.click(screen.getByText("See a quick demo"));
  await waitFor(() => expect(posts.map((p) => p.url)).toContain("/api/replay"));
});

test("sends with no folder so the service uses its default", async () => {
  render(<App />);
  fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), { target: { value: "fix the tests" } });
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body).toEqual({ mission: "fix the tests", workspace: null, verify_command: null });
});

test("sends a job using the saved settings", async () => {
  localStorage.setItem("ramlaal.settings", JSON.stringify({ workspace: "/workspaces/app", verify_command: "pytest -q" }));
  render(<App />);
  const box = screen.getByPlaceholderText(/Describe what you want/);
  fireEvent.change(box, { target: { value: "fix the tests" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    url: "/api/tasks",
    body: { mission: "fix the tests", workspace: "/workspaces/app", verify_command: "pytest -q" },
  });
});

test("plays the real demo ledger as a conversation", async () => {
  tasks = fixture.tasks;
  render(<App />);
  await waitFor(() => expect(screen.getAllByText(/Fix off-by-one/).length).toBeGreaterThan(0));
  for (const e of fixture.events) stream().emit(e);

  await waitFor(() => expect(screen.getAllByText(/Changed range\(n\) to range\(n \+ 1\)/).length).toBeGreaterThan(0));
  expect(screen.getAllByText(/saved a reviewed lesson/).length).toBeGreaterThan(0);

  fireEvent.click(screen.getAllByText("How I did it")[0]);
  expect(screen.getByText(/Trying again/)).toBeTruthy();
  expect(screen.queryByText(/^Cost:/)).toBeNull();
});

test("labels saved facts separately from reviewed lessons", async () => {
  tasks = [{ id: 1, mission: "tell me a joke", status: "completed", attempts: 1, workspace: "." }];
  render(<App />);
  stream().emit({
    id: 1,
    ts: 0,
    task_id: 1,
    peer: "memory",
    kind: "memory_written",
    payload: { id: "mem-1", memory_kind: "fact" },
  });

  await waitFor(() => expect(screen.getByText(/saved a note for next time/)).toBeTruthy());
  expect(screen.queryByText(/saved a reviewed lesson/)).toBeNull();
});

test("shows a permission question and answers it", async () => {
  tasks = [{ id: 1, mission: "do it", status: "running", attempts: 1, workspace: "/w", cost_usd: 0 }];
  render(<App />);
  await waitFor(() => expect(screen.getByText("do it")).toBeTruthy());
  stream().emit({ id: 1, ts: 0, task_id: 1, peer: "worker", kind: "codex", payload: { type: "approval_request", approvalId: "t:1", kind: "command", params: { command: "npm test" } } });
  await waitFor(() => expect(screen.getByText(/May I run this command/)).toBeTruthy());
  fireEvent.click(screen.getByText("Yes, go ahead"));
  await waitFor(() => expect(posts[0]).toEqual({ url: "/api/approvals/t%3A1", body: { decision: "accept" } }));
  expect(screen.queryByText(/May I run this command/)).toBeNull();
});

test("shows a clear message when the service is down", async () => {
  (fetch as any).mockRejectedValue(new Error("down"));
  render(<App />);
  await waitFor(() => expect(screen.getByText(/can't reach the helper service/)).toBeTruthy());
});
