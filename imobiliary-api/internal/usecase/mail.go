package usecase

import (
	"strconv"
	"strings"
)

// The messages the service sends. They are in Brazilian Portuguese, because
// the people who read them are, and they are plain text: an office receives
// them on a phone, and a message that needs images to be understood is a
// message that fails when they do not load.
//
// None of them carries anything the recipient did not already know about
// themselves, and none says whether an account exists except to the address
// that would own it.

func existingAccountMessage(name string) string {
	return join(
		"Olá, "+firstName(name)+".",
		"",
		"Alguém tentou criar uma conta no Imobiliary com este e-mail, que já tem conta.",
		"Se foi você, entre normalmente. Se não foi, ignore esta mensagem: nada mudou e",
		"ninguém teve acesso à sua conta.",
		"",
		"Imobiliary",
	)
}

func passwordResetMessage(name, link string, minutes int) string {
	return join(
		"Olá, "+firstName(name)+".",
		"",
		"Para definir uma nova senha no Imobiliary, abra o endereço abaixo:",
		"",
		link,
		"",
		"O link vale por "+plural(minutes, "minuto", "minutos")+" e só pode ser usado uma vez.",
		"Se você não pediu, ignore esta mensagem: sua senha continua a mesma.",
		"",
		"Imobiliary",
	)
}

func passwordChangedMessage(name string) string {
	return join(
		"Olá, "+firstName(name)+".",
		"",
		"A senha da sua conta no Imobiliary foi alterada, e as outras sessões foram",
		"encerradas.",
		"",
		"Se não foi você, redefina a senha agora e avise o administrador do escritório.",
		"",
		"Imobiliary",
	)
}

func accountDeletedMessage(name string) string {
	return join(
		"Olá, "+firstName(name)+".",
		"",
		"Sua conta no Imobiliary foi excluída, como você pediu. Seus dados de cadastro",
		"foram apagados, e não é possível entrar com este e-mail até criar uma conta nova.",
		"",
		"Os registros de acesso exigidos pelo Marco Civil da Internet ficam guardados por",
		"seis meses e depois são apagados.",
		"",
		"Se não foi você, escreva para o contato indicado na Política de Privacidade.",
		"",
		"Imobiliary",
	)
}

func invitationMessage(inviter, organization, link string, days int) string {
	return join(
		"Olá.",
		"",
		firstName(inviter)+" convidou você para o escritório "+organization+" no Imobiliary.",
		"Para aceitar e definir sua senha, abra o endereço abaixo:",
		"",
		link,
		"",
		"O convite vale por "+plural(days, "dia", "dias")+".",
		"Se você não esperava este convite, ignore esta mensagem.",
		"",
		"Imobiliary",
	)
}

func join(lines ...string) string { return strings.Join(lines, "\n") }

// firstName keeps a greeting short. A full legal name in a greeting reads like
// a form letter, which is what this is trying not to be.
func firstName(name string) string {
	first, _, _ := strings.Cut(strings.TrimSpace(name), " ")
	if first == "" {
		return "tudo bem"
	}
	return first
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}
