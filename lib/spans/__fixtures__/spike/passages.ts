// Original passages written for the mini spike (Nov 4 2026). Not copied from anywhere.
export interface Passage { id: string; source: string; target: string; sourceName: string; targetName: string; text: string }

export const PASSAGES: Passage[] = [
  {
    id: 'en-it', source: 'en', target: 'it', sourceName: 'English', targetName: 'Italian',
    text: "On Saturday morning, Laura O’Neill took the 8:15 train to the coast with her two brothers. They didn't plan much; they only wanted to see the sea again after a long winter in the city. The train was slow and crowded, but the view from the window was beautiful: green fields, small farms and, later, the first blue line of the water. At the station, a kind old man sold them three coffees and told them about a quiet beach behind the hill. The path was steep and the wind was cold, yet nobody complained. When they finally reached the beach, the sand was empty and the waves were loud. Laura took off her shoes and walked into the cold water. Her brothers laughed at her, then followed her. They stayed until the sun went down, talking about their parents, their jobs and the summers of their childhood. On the way back, everyone was tired but happy, and they promised to come back in June.",
  },
  {
    id: 'es-en', source: 'es', target: 'en', sourceName: 'Spanish', targetName: 'English',
    text: "El martes por la tarde, Carmen Ruiz abrió por fin la pequeña librería de su abuelo en el centro del pueblo. Durante 12 años el local estuvo cerrado, y el polvo cubría los estantes y las ventanas. Sus vecinos la ayudaron a limpiar todo en dos semanas. «¿Por qué no vendes el local?», le preguntó su hermano. Ella le contestó que los libros eran la memoria de la familia y que no quería perderla. Ahora la tienda abre a las 10:30 y cierra a las siete. Por la mañana vienen los niños de la escuela, que buscan cuentos con dibujos grandes. Por la tarde llegan los mayores, que prefieren las novelas de aventuras y el café que Carmen prepara en la trastienda. «Dámelo», dice siempre un señor que pide el mismo libro cada semana. Carmen sonríe, se lo da y le pregunta qué le pareció el final. El señor nunca contesta, pero vuelve el martes siguiente.",
  },
  {
    id: 'es-it', source: 'es', target: 'it', sourceName: 'Spanish', targetName: 'Italian',
    text: "Mi vecino Andrés tiene 74 años y cada domingo prepara una paella enorme para toda la calle. Empieza temprano: compra el arroz, el pollo y las verduras en el mercado, y después enciende el fuego en el patio. Los niños se acercan porque les encanta mirar cómo el arroz cambia de color. «No lo toques todavía», les dice Andrés, y ellos se ríen. Mientras la paella se cocina, los adultos ponen las mesas, traen sillas y hablan del tiempo, del fútbol y de los precios. A las dos en punto, Andrés grita que la comida está lista. Todos hacen fila con sus platos y él sirve a cada persona con mucha paciencia. Nadie sabe la receta exacta; él dice que el secreto es cocinar sin prisa y con buena compañía. Cuando termina el día, la calle huele a azafrán y a humo, y todos le dan las gracias antes de volver a casa.",
  },
];
