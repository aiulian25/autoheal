import type { Page } from "@playwright/test";

/**
 * How far the page reaches past the window's right edge (0 or less when nothing scrolls sideways), and the last three
 * elements that do so themselves rather than inside a box that scrolls sideways: its parent and its text.
 */
export const sidewaysOverflow = (page: Page) =>
  page.evaluate(() => {
    const width = window.innerWidth;
    const scrolls = (element: Element) => getComputedStyle(element).overflowX !== "visible";
    const inScrollingBox = (element: Element) => {
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        if (scrolls(parent)) {
          return true;
        }
      }
      return false;
    };
    const nameOf = (element: Element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
    const past = [...document.querySelectorAll("body *")]
      .filter((element) => element.getBoundingClientRect().right > width && !inScrollingBox(element))
      .slice(-3)
      .map(
        (element) => `${nameOf(element.parentElement!)} > ${nameOf(element)} "${element.textContent?.slice(0, 80)}"`,
      );
    return { overflow: document.documentElement.scrollWidth - width, past };
  });
