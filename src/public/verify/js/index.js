const errorBox = document.createElement('div');
const successBox = document.createElement('div');

errorBox.className = 'error-box';
successBox.className = 'success-box';

function getCookie(name) {
  const cookieArray = document.cookie.split(';');
  for (const cookie of cookieArray) {
    const [cookieName, cookieValue] = cookie.trim().split('=');
    if (cookieName === name) {
      return cookieValue;
    }
  }
  return null;
}

function verifyCode() {
  const codeInputs = document.querySelectorAll('.verification-code-input');
  let code = '';
  codeInputs.forEach(input => {
    code += input.value;
  });

  const email_verification_token = getCookie('email_verification_token');

  if (code.length === 6 && email_verification_token) {
    fetch(`/api/sso/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${email_verification_token}`
      },
      body: JSON.stringify({ email_verification_token, email_verification_code: code })
    })
      .then(handleResponse)
      .catch(handleError);
  }
}

function removeEmailVerificationToken() {
  var pastDate = new Date(0);
  document.cookie = "email_verification_token=; expires=" + pastDate.toUTCString() + "; path=/";
  return null;
}

function handleResponse(response) {
  if (response.status === 200) {
    removeEmailVerificationToken();
    window.location.href = '/home';
  } else if (response.status === 460) {
    handle460Error();
  } else {
    handleError();
  }
}

function handle460Error() {
  document.querySelector('.verification-code-input:first-child').focus();
  document.querySelectorAll('.verification-code-input').forEach(input => {
    input.value = '';
  });
  displayError('Error: Wrong verification code entered');
}

function handleError() {
  document.querySelector('.verification-code-input:first-child').focus();
  document.querySelectorAll('.verification-code-input').forEach(input => {
    input.value = '';
  });
  displayError('Something went wrong');
}

function displaySuccess(successMessage) {
  successBox.textContent = successMessage;
  document.body.appendChild(successBox);
  setTimeout(() => {
    successBox.remove();
  }, 2500);
}

function displayError(errorMessage) {
  errorBox.textContent = errorMessage;
  document.body.appendChild(errorBox);
  setTimeout(() => {
    errorBox.remove();
  }, 2500);
}

function moveToNextOrPreviousInput(input, isBackspace) {
  const maxLength = parseInt(input.getAttribute('maxlength'));
  const currentLength = input.value.length;
  
  if (isBackspace && currentLength === 0) {
    const previousInput = input.previousElementSibling;
    if (previousInput) {
      previousInput.focus();
    }
  } else if (!isBackspace && currentLength >= maxLength) {
    const nextInput = input.nextElementSibling;
    if (nextInput) {
      nextInput.focus();
    }
  }
}

function onlyNumbers(event) {
  const key = event.key;
  if (!/^\d$/.test(key) && key !== "Backspace") {
    event.preventDefault();
  }
}

function handleKeyDown(event) {
  const key = event.key;
  if (key === "Backspace") {
    const input = event.target;
    moveToNextOrPreviousInput(input, true);
  }
}

const codeInputs = document.querySelectorAll('.verification-code-input');
codeInputs.forEach(input => {
  input.addEventListener('input', function (e) {
    moveToNextOrPreviousInput(this, false);
    verifyCode();
  });
  input.addEventListener('keydown', handleKeyDown);
  input.addEventListener('keypress', onlyNumbers);
});

document.querySelector('.verification-code-input:first-child').focus();