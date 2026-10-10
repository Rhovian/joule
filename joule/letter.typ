#let doc = json(bytes(sys.inputs.document))
#set page(paper: "us-letter", margin: 1in)
#set text(font: "Libertinus Serif", size: 11pt)
#set par(spacing: 1.1em)
#let basics = doc.at("basics", default: (:))
#let value(entry, key) = { let v = entry.at(key, default: ""); if v == none { "" } else { str(v) } }
#text(size: 18pt, weight: "bold", value(basics, "name"))
#linebreak()
#value(basics, "email")
#v(1.5em)
#for paragraph in doc.text.split(regex("\n\s*\n")) { paragraph.trim(); parbreak() }
