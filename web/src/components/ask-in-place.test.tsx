import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEXT } from "../constants.js";
import { useAskInPlace } from "./ask-in-place.js";

function Card({ onRemove, onName }: { onRemove: () => void; onName: (name: string) => void }) {
  const asking = useAskInPlace();
  return (
    <div>
      <button type="button" onClick={() => asking.confirm("Remove the key?", onRemove)}>
        Remove
      </button>
      <button type="button" onClick={() => asking.askName("New folder's name", "", onName)}>
        New folder
      </button>
      {asking.question}
    </div>
  );
}

describe("a question asked in place", () => {
  afterEach(() => {
    cleanup();
    // jsdom has none: a test that watches scrolling puts one in.
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("comes into view as it is asked, only as far as it needs to", () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    render(<Card onRemove={vi.fn()} onName={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrolled.mock.contexts[0]).toBe(screen.getByRole("group", { name: "Remove the key?" }));
  });

  it("acts only once yes is said where the button is, and not at all on no", () => {
    const onRemove = vi.fn();
    render(<Card onRemove={onRemove} onName={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("group", { name: "Remove the key?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: TEXT.no }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Remove the key?" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Remove the key?" })).toBeNull();
  });

  it("takes an empty name where none is needed, as a way to clear one", () => {
    const onName = vi.fn();
    function Optional() {
      const asking = useAskInPlace();
      return (
        <div>
          <button type="button" onClick={() => asking.askName("Its name", "Printer", onName, { required: false })}>
            Rename
          </button>
          {asking.question}
        </div>
      );
    }
    render(<Optional />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Its name" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: TEXT.askInPlace.save }));
    expect(onName).toHaveBeenCalledWith("");
  });

  it("asks for a name in place, and takes none that is empty", () => {
    const onName = vi.fn();
    render(<Card onRemove={vi.fn()} onName={onName} />);
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.click(screen.getByRole("button", { name: TEXT.askInPlace.save }));
    expect(onName).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "New folder's name" }), { target: { value: " cache " } });
    fireEvent.click(screen.getByRole("button", { name: TEXT.askInPlace.save }));
    expect(onName).toHaveBeenCalledWith("cache");
  });
});

describe("where the dashboard asks", () => {
  it("asks only in place: no page opens the browser's own confirm or prompt dialog", () => {
    const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const dialogs = Object.entries(sources)
      .filter(([, source]) => /\bwindow\.(confirm|prompt)\s*\(/.test(source))
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(dialogs).toEqual([]);
  });
});
