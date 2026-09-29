import { Film, Folder } from "lucide-react";
import { ProgressBar } from "./ProgressBar";

export function ItemList({ containers, items, onOpenFolder, onPlayItem }) {
  return (
    <section id="browser">
      <ul id="itemList">
        {containers.map((c) => (
          <li key={c.id} onClick={() => onOpenFolder(c)}>
            <span className="item-label"><Folder size={15} /> {c.title}</span>
            <span className="badge">{c.childCount ?? ""} items</span>
          </li>
        ))}
        {items.map((item) => (
          <li key={item.id} className="media-item" onClick={() => onPlayItem(item)}>
            <div className="item-main">
              <span className="item-title"><Film size={15} /> {item.title}</span>
              <ProgressBar resume={item.resume} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
