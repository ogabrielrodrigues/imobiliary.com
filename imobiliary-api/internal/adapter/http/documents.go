package http

import (
	"net/http"
)

type documentFieldBody struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type documentFieldsBody struct {
	Fields []documentFieldBody `json:"fields"`
}

// handleContractDocumentFields answers every field a lease template can use,
// computed for one contract.
func (s *Server) handleContractDocumentFields(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	fields, err := s.documents.ContractFields(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := documentFieldsBody{Fields: make([]documentFieldBody, 0, len(fields))}
	for _, f := range fields {
		out.Fields = append(out.Fields, documentFieldBody{Name: f.Name, Value: f.Value})
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}
