package usecase

import (
	"fmt"
	"strings"
	"time"
)

// The two messages this service sends, both in Brazilian Portuguese because
// that is the language of the interface, and both plain text.
//
// They are deliberately short and say only what the reader has to decide on. A
// password mail that reads like marketing teaches people to ignore the one that
// matters, and the second message here exists precisely so that a victim of an
// account takeover notices it.

// resetMessage is the mail carrying a reset link.
func resetMessage(name, link string, ttl time.Duration) string {
	return strings.Join([]string{
		greeting(name),
		"",
		"Recebemos um pedido para redefinir a senha da sua conta no Imobiliary Docs.",
		"Para escolher uma nova senha, acesse:",
		"",
		link,
		"",
		fmt.Sprintf("O link vale por %s e só pode ser usado uma vez.", humanDuration(ttl)),
		"",
		"Se não foi você que pediu, ignore esta mensagem: sua senha continua a",
		"mesma e nenhuma ação é necessária.",
		"",
		"— Imobiliary Docs",
	}, "\n")
}

// changedMessage tells someone their password changed.
func changedMessage(name string) string {
	return strings.Join([]string{
		greeting(name),
		"",
		"A senha da sua conta no Imobiliary Docs acaba de ser alterada, e as",
		"sessões abertas em outros dispositivos foram encerradas.",
		"",
		"Se foi você, não precisa fazer nada.",
		"",
		"Se não foi, sua conta pode estar comprometida: redefina a senha",
		"imediatamente e fale conosco.",
		"",
		"— Imobiliary Docs",
	}, "\n")
}

// greeting addresses the reader by their first name when there is one.
func greeting(name string) string {
	first, _, _ := strings.Cut(strings.TrimSpace(name), " ")
	if first == "" {
		return "Olá,"
	}
	return "Olá, " + first + ","
}

// humanDuration writes a duration the way the message needs to read it.
func humanDuration(d time.Duration) string {
	switch minutes := int(d.Minutes()); {
	case minutes >= 120 && minutes%60 == 0:
		return fmt.Sprintf("%d horas", minutes/60)
	case minutes >= 60 && minutes < 120:
		return "1 hora"
	default:
		return fmt.Sprintf("%d minutos", minutes)
	}
}
