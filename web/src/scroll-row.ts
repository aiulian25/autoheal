/**
 * On a narrow screen a menu is one row that scrolls sideways: its current item is brought to the row's middle. Only
 * the row moves; scrollIntoView would also scroll the page. Where the row does not scroll, nothing changes.
 */
export function bringToMiddle(row: HTMLElement, item: HTMLElement) {
  const { left, width } = item.getBoundingClientRect();
  row.scrollLeft += left - row.getBoundingClientRect().left - (row.clientWidth - width) / 2;
}
