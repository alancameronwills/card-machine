node server/update_code.js $1 && 
	mv temp .. &&
	cp -r ../temp/* . &&
	rm -r ../temp
