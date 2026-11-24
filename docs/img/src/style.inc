// Shared style of the zanzibar-*.dot diagrams. Render each with:
//   sed -e "/#include/{r style.inc" -e "d}" NAME.dot | dot -Tsvg -o ../NAME.svg
	graph [fontname="DejaVu Sans", fontsize=14, fontcolor="#17344a", pad=0.3, nodesep=0.35, ranksep=0.4, bgcolor="#ffffff"];
	node [shape=box, style="rounded,filled", fillcolor="#edf4f8", color="#7691a4", penwidth=1.2, fontname="DejaVu Sans", fontsize=14, fontcolor="#17344a", margin="0.15,0.08"];
	edge [color="#516c7a", arrowsize=0.7, fontname="DejaVu Sans", fontsize=12, fontcolor="#324e5c"];
