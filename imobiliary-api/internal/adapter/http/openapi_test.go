package http

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// TestOpenAPIDescribesEveryRoute keeps openapi.yaml and the route table in
// step. It reads both as text, since the module has no YAML parser and should
// not gain one for a test: a route added without its contract, or a contract
// left behind by a removed route, fails here rather than in a client.
func TestOpenAPIDescribesEveryRoute(t *testing.T) {
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	var routes []string
	for _, m := range regexp.MustCompile(`mux\.Handle(?:Func)?\("([A-Z]+ /[^"]*)"`).FindAllSubmatch(source, -1) {
		routes = append(routes, string(m[1]))
	}

	spec, err := os.ReadFile("../../../openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	_, paths, found := strings.Cut(string(spec), "\npaths:\n")
	if !found {
		t.Fatal("openapi.yaml has no paths section")
	}
	paths, _, _ = strings.Cut(paths, "\ncomponents:\n")

	var described []string
	current := ""
	pathLine := regexp.MustCompile(`^  (/\S*):$`)
	methodLine := regexp.MustCompile(`^    (get|post|put|patch|delete):$`)
	for line := range strings.SplitSeq(paths, "\n") {
		if m := pathLine.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		if m := methodLine.FindStringSubmatch(line); m != nil && current != "" {
			described = append(described, strings.ToUpper(m[1])+" "+current)
		}
	}

	slices.Sort(routes)
	slices.Sort(described)
	for _, route := range routes {
		if !slices.Contains(described, route) {
			t.Errorf("%s is served but not described in openapi.yaml", route)
		}
	}
	for _, operation := range described {
		if !slices.Contains(routes, operation) {
			t.Errorf("%s is described in openapi.yaml but not served", operation)
		}
	}
	if len(routes) == 0 {
		t.Fatal("no routes were read from server.go")
	}
}
