import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT } from "../constants.js";
import { ScrollToTop } from "./scroll-to-top.js";

const scrollTo = vi.fn();
const scrolledTo = (y: number) =>
  act(() => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  });
const button = () => screen.queryByRole("button", { name: TEXT.scrollToTop });

beforeEach(() => {
  scrollTo.mockClear();
  vi.stubGlobal("scrollTo", scrollTo);
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the way back to the top", () => {
  it("is there only once a person has scrolled away, and goes when they are back", () => {
    render(<ScrollToTop />);
    expect(button()).toBeNull();
    scrolledTo(100);
    expect(button()).toBeNull();
    scrolledTo(900);
    expect(button()).not.toBeNull();
    scrolledTo(0);
    expect(button()).toBeNull();
  });

  it("goes to the top, smoothly unless a person asked for less motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    render(<ScrollToTop />);
    scrolledTo(900);
    fireEvent.click(button()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    fireEvent.click(button()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
  });
});
